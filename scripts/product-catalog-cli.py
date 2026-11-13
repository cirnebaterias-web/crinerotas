#!/usr/bin/env python3
"""Valida, visualiza e publica o catálogo Clarios usado pelo aplicativo."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import unicodedata
from collections import Counter
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from zipfile import BadZipFile

from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException


BRANDS = {"Heliar": "Heliar", "América": "América", "Durex / Strada": "Durex", "ACDelco": "ACDelco"}
REQUIRED = ["Cód.Fábrica", "Descrição Cirne", "Item original", "SKU/base", "Fabricante/Marca", "Peso kg"]
REQUIRED += ["Amperagem (Ah)", "Tecnologia"]
TECHNOLOGIES = {"sli": "SLI", "sli/frota": "SLI", "efb": "EFB", "efb/frota": "EFB",
                "agm": "AGM", "agm/frota": "AGM", "agm moto": "AGM"}
IDENTITY_FIELDS = ("id", "factoryCode", "sku", "brand", "model", "description", "unitWeightKg", "weightSource")


def normalize_text(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    return " ".join("".join(char for char in text if not unicodedata.combining(char)).casefold().split())


def amperage(value: object) -> int | float | None:
    if value is None or isinstance(value, bool) or not str(value).strip():
        return None
    try:
        number = Decimal(str(value).strip().replace(",", "."))
    except InvalidOperation:
        return None
    if not number.is_finite() or number <= 0 or number > 9007199254740991:
        return None
    canonical = int(number) if number == number.to_integral() else float(number)
    return canonical if canonical > 0 else None


def decimal_text(value: object) -> str | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        number = Decimal(str(value).replace(",", "."))
    except InvalidOperation as error:
        raise ValueError(f"peso inválido: {value}") from error
    if not number.is_finite() or number <= 0:
        raise ValueError(f"peso deve ser positivo: {value}")
    return format(number.normalize(), "f")


def read_products(source: Path, diagnostics: list[dict[str, object]] | None = None) -> list[dict[str, object]]:
    diagnostics = diagnostics if diagnostics is not None else []
    workbook = load_workbook(source, read_only=True, data_only=True)
    try:
        return read_sheet(workbook.active, diagnostics)
    finally:
        workbook.close()


def read_sheet(sheet, diagnostics: list[dict[str, object]]) -> list[dict[str, object]]:
    rows = sheet.iter_rows(values_only=True)
    headers = [str(value).strip() if value is not None else "" for value in next(rows, ())]
    missing = [header for header in REQUIRED if header not in headers]
    if missing:
        raise ValueError("cabeçalhos ausentes: " + ", ".join(missing))
    if any(headers.count(header) > 1 for header in REQUIRED):
        raise ValueError("cabeçalhos obrigatórios duplicados")
    index = {header: headers.index(header) for header in REQUIRED}
    products: list[dict[str, object]] = []
    seen_codes: set[str] = set()
    for row_number, row in enumerate(rows, start=2):
        code = str(row[index["Cód.Fábrica"]] or "").strip()
        description = str(row[index["Descrição Cirne"]] or "").strip()
        model = str(row[index["Item original"]] or "").strip()
        sku = str(row[index["SKU/base"]] or "").strip()
        source_brand = str(row[index["Fabricante/Marca"]] or "").strip()
        raw_weight = row[index["Peso kg"]]
        weight_present = raw_weight is not None and str(raw_weight).strip() != ""
        if not any((code, description, model, sku, source_brand, weight_present)):
            continue
        if not code or not description or not model or source_brand not in BRANDS:
            raise ValueError(
                f"linha {row_number}: código, descrição, item original ou marca inválidos"
            )
        stable_id = f"{BRANDS[source_brand].lower()}:{code.lower()}"
        normalized_code = code.casefold()
        if normalized_code in seen_codes:
            raise ValueError(f"linha {row_number}: código de fábrica duplicado: {code}")
        seen_codes.add(normalized_code)
        weight = decimal_text(raw_weight)
        raw_ah = row[index["Amperagem (Ah)"]]
        raw_technology = row[index["Tecnologia"]]
        ah = amperage(raw_ah)
        technology = TECHNOLOGIES.get(normalize_text(raw_technology))
        if ah is None:
            diagnostics.append({"code": "MISSING_AMPERAGE" if raw_ah is None or not str(raw_ah).strip()
                                else "INVALID_AMPERAGE", "row": row_number, "productCode": code})
        if technology is None:
            diagnostics.append({"code": "UNKNOWN_TECHNOLOGY", "row": row_number, "productCode": code,
                                "value": str(raw_technology or "").strip()})
        products.append({
            "id": stable_id,
            "factoryCode": code,
            "sku": sku or code,
            "brand": BRANDS[source_brand],
            "model": model,
            "description": description,
            "unitWeightKg": weight or "15",
            "weightSource": "catalog" if weight else "fallback_15kg",
            "amperageAh": ah,
            "technology": technology,
        })
    if not products:
        raise ValueError("a planilha não contém produtos")
    return products


def product_identity_hash(products: list[dict[str, object]]) -> str:
    identity = [{key: product[key] for key in IDENTITY_FIELDS} for product in products]
    return hashlib.sha256(json.dumps(identity, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def verify_published(products: list[dict[str, object]], artifact: Path, version: int,
                     valid_from: str | None = None) -> str:
    content = artifact.read_text(encoding="utf-8")
    version_match = re.search(r"GENERATED_STOCK_CATALOG_VERSION = (\d+);", content)
    payload = re.search(r"generatedOwnProductItems = (\[.*\]) as const;", content, re.DOTALL)
    if not version_match or int(version_match[1]) != version or not payload:
        raise ValueError("versão publicada não comprovada pelo artefato informado")
    if valid_from is not None:
        date_match = re.search(r"GENERATED_STOCK_CATALOG_VALID_FROM = '([^']+)';", content)
        if not date_match or date_match[1] != valid_from:
            raise ValueError("data de vigência divergente da versão publicada; preserve a versão histórica")
    original = json.loads(payload[1])
    if product_identity_hash(original) != product_identity_hash(products):
        raise ValueError("origem divergente: códigos/metadados/pesos diferem da versão publicada")
    for old, new in zip(original, products):
        if any(key in old and old[key] != new[key] for key in ("amperageAh", "technology")):
            raise ValueError("metadados analíticos divergentes da versão publicada; preserve a versão histórica")
    return product_identity_hash(original)


def render(products: list[dict[str, object]], version: int, valid_from: str,
           provenance: dict[str, object] | None = None) -> str:
    payload = json.dumps(products, ensure_ascii=False, indent=2)
    return (
        "// Gerado por scripts/product-catalog-cli.py. Não edite manualmente.\n"
        f"export const GENERATED_STOCK_CATALOG_VERSION = {version};\n"
        f"export const GENERATED_STOCK_CATALOG_VALID_FROM = '{valid_from}';\n"
        f"export const GENERATED_STOCK_CATALOG_PROVENANCE = {json.dumps(provenance or {}, ensure_ascii=False, indent=2)} as const;\n"
        f"export const generatedOwnProductItems = {payload} as const;\n"
    )


def publish_artifact(output: Path, content: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=output.parent, prefix=f".{output.name}.",
                                         suffix=".tmp", delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(content)
        os.replace(temporary_path, output)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["validate", "preview", "publish"])
    parser.add_argument("source", type=Path)
    parser.add_argument("--version", type=int, default=2)
    parser.add_argument("--valid-from", default="2026-10-02")
    parser.add_argument("--output", type=Path, default=Path("packages/domain/src/own-product-catalog.generated.ts"))
    parser.add_argument("--verify-published", type=Path,
                        help="comprova que todos os campos históricos da versão permanecem idênticos")
    args = parser.parse_args()
    try:
        if args.version < 1:
            raise ValueError("versão deve ser positiva")
        date.fromisoformat(args.valid_from)
        diagnostics: list[dict[str, object]] = []
        products = read_products(args.source, diagnostics)
        identity_hash = None
        if args.command == "publish" and args.output.exists():
            identity_hash = verify_published(products, args.output, args.version, args.valid_from)
        if args.verify_published:
            identity_hash = verify_published(products, args.verify_published, args.version, args.valid_from)
        provenance = {"source": args.source.name, "sourceSha256": hashlib.sha256(args.source.read_bytes()).hexdigest(),
                      "identitySha256": product_identity_hash(products), "verifiedPublishedIdentitySha256": identity_hash,
                      "metadataColumns": {"amperageAh": "Amperagem (Ah)", "technology": "Tecnologia"},
                      "metadataRulesVersion": 1}
        if args.command == "publish":
            publish_artifact(args.output, render(products, args.version, args.valid_from, provenance))
    except (ValueError, OSError, BadZipFile, InvalidFileException) as error:
        print(json.dumps({"ok": False, "diagnostics": [{"code": "INVALID_CATALOG", "message": str(error)}]},
                         ensure_ascii=False, indent=2))
        sys.exit(1)
    counts = Counter(str(product["brand"]) for product in products)
    fallback = sum(product["weightSource"] == "fallback_15kg" for product in products)
    classified = sum(product["amperageAh"] is not None and product["technology"] is not None for product in products)
    summary = {"ok": True, "products": len(products), "brands": dict(counts), "fallbackWeights": fallback,
               "version": args.version, "coverage": {"classifiedProducts": classified,
               "unclassifiedProducts": len(products) - classified,
               "withAmperage": sum(product["amperageAh"] is not None for product in products),
               "withTechnology": sum(product["technology"] is not None for product in products)},
               "diagnostics": diagnostics, "provenance": provenance}
    if args.command == "preview":
        summary["preview"] = products[:5]
    if args.command == "publish":
        summary["output"] = str(args.output)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
