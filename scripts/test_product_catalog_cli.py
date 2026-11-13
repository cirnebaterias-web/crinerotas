"""Synthetic workbook regression tests; never requires the user's source file."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from openpyxl import Workbook, load_workbook

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("catalog", Path(__file__).with_name("product-catalog-cli.py"))
catalog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog)


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / "synthetic.xlsx"

    def workbook(self, rows, headers=None):
        workbook = Workbook()
        workbook.active.append(headers or catalog.REQUIRED)
        for row in rows:
            workbook.active.append(row)
        workbook.save(self.source)
        workbook.close()
        return self.source

    def row(self, code="A", ah=60, technology="SLI", weight="18,7", model="SAME MODEL"):
        return [code, "Description", model, "SKU", "Heliar", weight, ah, technology]

    def test_normalizes_only_explicit_technology_families(self):
        technologies = ["SLI", "SLI/Frota", " EFB ", "efb/FROTA", "AGM", "AGM/Frota", " ágM  Moto ",
                        "Convencional", "SLI premium", "", "Tec. SLI"]
        self.workbook([self.row(str(index), technology=value) for index, value in enumerate(technologies)])
        diagnostics = []
        products = catalog.read_products(self.source, diagnostics)
        self.assertEqual([product["technology"] for product in products],
                         ["SLI", "SLI", "EFB", "EFB", "AGM", "AGM", "AGM", None, None, None, None])
        self.assertEqual(len(diagnostics), 4)

    def test_invalid_and_missing_ah_stay_null_without_model_inference(self):
        values = [None, "", "60 Ah", "NaN", "Infinity", -1, 0, True, "9007199254740992", "1e-1000", "62", "60,5"]
        self.workbook([self.row(str(index), ah=value, model="HE60DD") for index, value in enumerate(values)])
        diagnostics = []
        products = catalog.read_products(self.source, diagnostics)
        self.assertEqual([product["amperageAh"] for product in products], [None] * 10 + [62, 60.5])
        self.assertEqual([entry["code"] for entry in diagnostics[:2]], ["MISSING_AMPERAGE"] * 2)
        self.assertTrue(all(entry["code"] == "INVALID_AMPERAGE" for entry in diagnostics[2:]))

    def test_identity_homonyms_and_weight_origins_are_preserved(self):
        self.workbook([self.row("A"), self.row("B", weight=None)])
        products = catalog.read_products(self.source)
        self.assertEqual([item["model"] for item in products], ["SAME MODEL"] * 2)
        self.assertEqual([item["factoryCode"] for item in products], ["A", "B"])
        self.assertEqual([item["unitWeightKg"] for item in products], ["18.7", "15"])
        self.assertEqual([item["weightSource"] for item in products], ["catalog", "fallback_15kg"])
        self.workbook([self.row("A"), self.row("a")])
        with self.assertRaisesRegex(ValueError, "duplicado"):
            catalog.read_products(self.source)

    def test_headers_required_and_duplicate_headers_rejected(self):
        for missing in ("Amperagem (Ah)", "Tecnologia"):
            self.workbook([], [header for header in catalog.REQUIRED if header != missing])
            with self.assertRaisesRegex(ValueError, missing.replace("(", r"\(").replace(")", r"\)")):
                catalog.read_products(self.source)
        self.workbook([], catalog.REQUIRED + ["Tecnologia"])
        with self.assertRaisesRegex(ValueError, "duplicados"):
            catalog.read_products(self.source)

    def test_nonfinite_weight_is_rejected(self):
        for weight in ("NaN", "Infinity", "-Infinity", 0, -1):
            self.workbook([self.row(weight=weight)])
            with self.assertRaises(ValueError):
                catalog.read_products(self.source)

    def run_cli(self, command, *args):
        result = subprocess.run([sys.executable, str(Path(catalog.__file__)), command, str(self.source), *args],
                                capture_output=True, encoding="utf-8", env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        return result, json.loads(result.stdout)

    def test_cli_determinism_coverage_and_historical_protection(self):
        self.workbook([self.row("A"), self.row("B", ah=None, technology="Convencional")])
        artifact = Path(self.temp.name) / "catalog.generated.ts"
        first, summary = self.run_cli("publish", "--output", str(artifact))
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(summary["coverage"], {"classifiedProducts": 1, "unclassifiedProducts": 1,
                                             "withAmperage": 1, "withTechnology": 1})
        expected = artifact.read_bytes()
        self.assertEqual(summary["provenance"]["verifiedPublishedIdentitySha256"],
                         summary["provenance"]["identitySha256"])
        second, verified = self.run_cli("publish", "--output", str(artifact))
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(expected, artifact.read_bytes())
        self.assertEqual(verified["provenance"]["verifiedPublishedIdentitySha256"],
                         verified["provenance"]["identitySha256"])
        third, _ = self.run_cli("publish", "--output", str(artifact))
        self.assertEqual(third.returncode, 0, third.stderr)
        self.assertEqual(expected, artifact.read_bytes())
        self.workbook([self.row("A", ah=62), self.row("B", ah=None, technology="Convencional")])
        result, error = self.run_cli("publish", "--output", str(artifact))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(error["ok"])
        self.assertEqual(expected, artifact.read_bytes())
        self.workbook([self.row("C"), self.row("B", ah=None, technology="Convencional")])
        result, error = self.run_cli("validate", "--verify-published", str(artifact))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("origem divergente", error["diagnostics"][0]["message"])

    def test_same_version_rejects_changed_source_bytes_or_name(self):
        self.workbook([self.row()])
        artifact = Path(self.temp.name) / "catalog.generated.ts"
        result, _ = self.run_cli("publish", "--output", str(artifact))
        self.assertEqual(result.returncode, 0)
        expected = artifact.read_bytes()
        original_bytes = self.source.read_bytes()
        original_products = catalog.read_products(self.source)
        workbook = load_workbook(self.source)
        workbook.properties.title = "Changed document metadata only"
        workbook.save(self.source)
        workbook.close()
        self.assertNotEqual(self.source.read_bytes(), original_bytes)
        self.assertEqual(catalog.read_products(self.source), original_products)
        for flags in ([], ["--verify-published", str(artifact)]):
            result, error = self.run_cli("publish", "--output", str(artifact), *flags)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("proveniência divergente", error["diagnostics"][0]["message"])
            self.assertEqual(artifact.read_bytes(), expected)
        renamed = self.source.with_name("renamed.xlsx")
        renamed.write_bytes(original_bytes)
        self.source = renamed
        result, error = self.run_cli("publish", "--output", str(artifact))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("proveniência divergente", error["diagnostics"][0]["message"])
        self.assertEqual(artifact.read_bytes(), expected)

    def test_legacy_v2_bootstrap_requires_explicit_anchor_then_is_immutable(self):
        self.workbook([self.row()])
        products = catalog.read_products(self.source)
        legacy = [{key: value for key, value in product.items()
                   if key not in ("amperageAh", "technology")} for product in products]
        artifact = Path(self.temp.name) / "legacy.generated.ts"
        artifact.write_text(catalog.render(legacy, 2, "2026-10-02"), encoding="utf-8")
        expected = artifact.read_bytes()
        result, error = self.run_cli("publish", "--output", str(artifact))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bootstrap explícito", error["diagnostics"][0]["message"])
        self.assertEqual(artifact.read_bytes(), expected)
        result, summary = self.run_cli("publish", "--output", str(artifact),
                                       "--verify-published", str(artifact))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(summary["provenance"]["verifiedPublishedIdentitySha256"],
                         summary["provenance"]["identitySha256"])
        published = artifact.read_bytes()
        result, repeated = self.run_cli("publish", "--output", str(artifact))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(published, artifact.read_bytes())
        self.assertEqual(summary["provenance"], repeated["provenance"])

    def test_republish_preserves_provenance_and_effective_date(self):
        self.workbook([self.row()])
        products = catalog.read_products(self.source)
        artifact = Path(self.temp.name) / "published.generated.ts"
        artifact.write_text(catalog.render(products, 2, "2026-10-02"), encoding="utf-8")
        # An explicit historical check establishes provenance. A subsequent
        # publish without that flag must retain its verified identity hash.
        result, explicit = self.run_cli("publish", "--output", str(artifact),
                                        "--verify-published", str(artifact))
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = artifact.read_bytes()
        result, automatic = self.run_cli("publish", "--output", str(artifact))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(automatic["provenance"], explicit["provenance"])
        self.assertEqual(artifact.read_bytes(), expected)
        for flags in ([], ["--verify-published", str(artifact)]):
            result, error = self.run_cli("publish", "--output", str(artifact),
                                         "--valid-from", "2026-11-12", *flags)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(error["ok"])
            self.assertIn("data de vigência divergente", error["diagnostics"][0]["message"])
            self.assertEqual(artifact.read_bytes(), expected)
        new_artifact = Path(self.temp.name) / "v3.generated.ts"
        result, newer = self.run_cli("publish", "--output", str(new_artifact), "--version", "3",
                                     "--valid-from", "2026-11-12")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(newer["version"], 3)
        self.assertEqual(artifact.read_bytes(), expected)

    def test_cli_structural_error_is_one_json_document(self):
        self.workbook([], ["not a catalog"])
        result, error = self.run_cli("preview")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(error["ok"])
        self.assertEqual(error["diagnostics"][0]["code"], "INVALID_CATALOG")

    def test_publish_failures_preserve_existing_artifact_and_return_json(self):
        self.workbook([self.row()])
        artifact = Path(self.temp.name) / "published.generated.ts"
        result, _ = self.run_cli("publish", "--output", str(artifact))
        self.assertEqual(result.returncode, 0)
        expected = artifact.read_bytes()
        actual_factory = catalog.tempfile.NamedTemporaryFile

        def failing_writer(*args, **kwargs):
            temporary = actual_factory(*args, **kwargs)
            actual_write = temporary.write

            def partial_write(content):
                actual_write(content[:20])
                raise OSError("synthetic disk full")

            temporary.write = partial_write
            return temporary

        failures = [
            patch.object(Path, "mkdir", side_effect=OSError("synthetic mkdir denied")),
            patch.object(catalog.tempfile, "NamedTemporaryFile", side_effect=failing_writer),
            patch.object(catalog.os, "replace", side_effect=OSError("synthetic replace denied")),
        ]
        for failure in failures:
            with self.subTest(failure=failure), failure, patch.object(sys, "argv", [
                "product-catalog-cli.py", "publish", str(self.source), "--output", str(artifact)
            ]), redirect_stdout(io.StringIO()) as stdout:
                with self.assertRaises(SystemExit) as exit_status:
                    catalog.main()
                self.assertEqual(exit_status.exception.code, 1)
                error = json.loads(stdout.getvalue())
                self.assertFalse(error["ok"])
                self.assertEqual(error["diagnostics"][0]["code"], "INVALID_CATALOG")
                self.assertIn("synthetic", error["diagnostics"][0]["message"])
                self.assertEqual(artifact.read_bytes(), expected)
                self.assertEqual(list(artifact.parent.glob(f".{artifact.name}.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
