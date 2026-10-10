"""
Tests for normalize_api_url and utilities
"""

import os
import unittest
import warnings
from allevitas.utils import normalize_api_url, DEFAULT_API_URL
from allevitas.client import AllevitasClient


class TestNormalizeApiUrl(unittest.TestCase):
    def test_default_api_url_when_none(self):
        old_env = os.environ.pop("ALLEVITAS_API_URL", None)
        try:
            self.assertEqual(normalize_api_url(), DEFAULT_API_URL)
        finally:
            if old_env is not None:
                os.environ["ALLEVITAS_API_URL"] = old_env

    def test_strips_trailing_slashes(self):
        self.assertEqual(
            normalize_api_url("https://allevitas.com/api/"),
            "https://allevitas.com/api",
        )
        self.assertEqual(
            normalize_api_url("https://allevitas.com/api///"),
            "https://allevitas.com/api",
        )

    def test_normalizes_ja_api_to_api(self):
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            normalized = normalize_api_url("https://allevitas.com/ja/api")
            self.assertEqual(normalized, "https://allevitas.com/api")
            self.assertEqual(len(w), 1)
            self.assertTrue(issubclass(w[-1].category, UserWarning))
            self.assertIn("Detected locale prefix in API URL", str(w[-1].message))

        with warnings.catch_warnings(record=True):
            warnings.simplefilter("always")
            self.assertEqual(
                normalize_api_url("https://allevitas.com/ja/api/"),
                "https://allevitas.com/api",
            )

    def test_normalizes_en_api_to_api(self):
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            normalized = normalize_api_url("https://allevitas.com/en/api")
            self.assertEqual(normalized, "https://allevitas.com/api")
            self.assertEqual(len(w), 1)

    def test_local_url(self):
        self.assertEqual(
            normalize_api_url("http://localhost:3000/api"),
            "http://localhost:3000/api",
        )
        with warnings.catch_warnings(record=True):
            warnings.simplefilter("always")
            self.assertEqual(
                normalize_api_url("http://localhost:3000/ja/api/"),
                "http://localhost:3000/api",
            )

    def test_client_constructor_normalizes_url(self):
        with warnings.catch_warnings(record=True):
            warnings.simplefilter("always")
            client = AllevitasClient(api_url="https://allevitas.com/ja/api")
            self.assertEqual(client.api_url, "https://allevitas.com/api")


if __name__ == "__main__":
    unittest.main()
