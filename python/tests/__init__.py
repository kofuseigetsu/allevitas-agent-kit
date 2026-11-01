"""
allevitas-agent-kit tests package
"""

# Isolate tests from the developer's machine, before anything imports allevitas: a default
# credentials path would read and overwrite a real ./.credentials.json, and the CLI loads .env.
import os
import tempfile

os.environ["ALLEVITAS_CREDENTIALS_PATH"] = os.path.join(
    tempfile.gettempdir(), f"allevitas-test-{os.getpid()}", "credentials.json"
)
os.environ["ALLEVITAS_KEYRING"] = "off"
for _key in ("ALLEVITAS_AGENT_KEY", "ALLEVITAS_TOKEN", "ALLEVITAS_ACCOUNT_ID", "ALLEVITAS_RECOVERY_KEY_FILE"):
    os.environ[_key] = ""
