#!/usr/bin/env python3
"""Valida, visualiza e publica o catálogo Clarios usado pelo aplicativo."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from decimal import Decimal, InvalidOperation
from pathlib import Path

from openpyxl import load_workbook


BRANDS = {"Heliar": "Heliar", "América": "América", "Durex / Strada": "Durex", "ACDelco": "ACDelco"}
REQUIRED = ["Cód.Fábrica", "Descrição Cirne", "Item original", "SKU/base", "Fabricante/Marca", "Peso kg"]


def decimal_text(value: object) -> str | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        number = Decimal(str(value).replace(",", "."))
    except InvalidOperation as error:
        raise ValueError(f"peso inválido: {value}") from error
    if number <= 0:
        raise ValueError(f"peso deve ser positivo: {value}")
    return format(number.normalize(), "f")


def read_products(source: Path) -> list[dict[str, object]]:
    workbook = load_workbook(source, read_only=True, data_only=True)
    sheet = workbook.active
    rows = sheet.iter_rows(values_only=True)
    headers = [str(value).strip() if value is not None else "" for value in next(rows)]
    missing = [header for header in REQUIRED if header not in headers]
    if missing:
        raise ValueError("cabeçalhos ausentes: " + ", ".join(missing))
    index = {header: headers.index(header) for header in REQUIRED}
    products: list[dict[str, object]] = []
    seen_codes: set[str] = set()
    for row_number, row in enumerate(rows, start=2):
        code = str(row[index["Cód.Fábrica"]] or "").strip()
        description = str(row[index["Descrição Cirne"]] or "").strip()
        model = str(row[index["Item original"]] or "").strip()
        sku = str(row[index["SKU/base"]] or "").strip()
        source_brand = str(row[index["Fabricante/Marca"]] or "").strip()
        if not any((code, model, sku, source_brand)):
            continue
        if not code or not model or source_brand not in BRANDS:
            raise ValueError(f"linha {row_number}: código, descrição ou marca inválidos")
        stable_id = f"{BRANDS[source_brand].lower()}:{code.lower()}"
        normalized_code = code.casefold()
        if normalized_code in seen_codes:
            raise ValueError(f"linha {row_number}: código de fábrica duplicado: {code}")
        seen_codes.add(normalized_code)
        weight = decimal_text(row[index["Peso kg"]])
        products.append({
            "id": stable_id,
            "factoryCode": code,
            "sku": sku or code,
            "brand": BRANDS[source_brand],
            "model": model,
            "description": description,
            "unitWeightKg": weight or "15",
            "weightSource": "catalog" if weight else "fallback_15kg",
        })
    if not products:
        raise ValueError("a planilha não contém produtos")
    return products


def render(products: list[dict[str, object]], version: int, valid_from: str) -> str:
    payload = json.dumps(products, ensure_ascii=False, indent=2)
    return (
        "// Gerado por scripts/product-catalog-cli.py. Não edite manualmente.\n"
        f"export const GENERATED_STOCK_CATALOG_VERSION = {version};\n"
        f"export const GENERATED_STOCK_CATALOG_VALID_FROM = '{valid_from}';\n"
        f"export const generatedOwnProductItems = {payload} as const;\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["validate", "preview", "publish"])
    parser.add_argument("source", type=Path)
    parser.add_argument("--version", type=int, default=2)
    parser.add_argument("--valid-from", default="2026-10-02")
    parser.add_argument("--output", type=Path, default=Path("apps/web/src/features/visits/stock/own-product-catalog.generated.ts"))
    args = parser.parse_args()
    products = read_products(args.source)
    counts = Counter(str(product["brand"]) for product in products)
    fallback = sum(product["weightSource"] == "fallback_15kg" for product in products)
    summary = {"products": len(products), "brands": dict(counts), "fallbackWeights": fallback, "version": args.version}
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.command == "preview":
        print(json.dumps(products[:5], ensure_ascii=False, indent=2))
    if args.command == "publish":
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(render(products, args.version, args.valid_from), encoding="utf-8")
        print(f"publicado: {args.output}")


if __name__ == "__main__":
    main()
