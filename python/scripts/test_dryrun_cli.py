import argparse
import json
import os
import re
import subprocess
import sys

current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)


def parse_args():
    parser = argparse.ArgumentParser(description="Allevitas Real API Python CLI Dry-Run Suite")
    parser.add_argument(
        "-c", "--credentials",
        default="./.credentials.json",
        help="Path to credentials JSON file (default: ./.credentials.json)"
    )
    parser.add_argument(
        "--api-url",
        default="https://allevitas.com/api",
        help="Allevitas API base URL (default: https://allevitas.com/api)"
    )
    return parser.parse_args()


def run_cli(cli_args, cwd=parent_dir):
    cmd = [sys.executable, "-m", "allevitas.cli"] + cli_args
    res = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if res.returncode != 0:
        print(f"Command failed: {' '.join(cmd)}", file=sys.stderr)
        print(f"STDOUT:\n{res.stdout}", file=sys.stderr)
        print(f"STDERR:\n{res.stderr}", file=sys.stderr)
        raise RuntimeError(f"CLI command exited with code {res.returncode}")
    return res.stdout


def main():
    args = parse_args()
    credentials_path = os.path.abspath(args.credentials)
    api_url = args.api_url

    print("=================================================")
    print("  Allevitas Real API Python CLI Dry-Run Suite    ")
    print("=================================================")
    print(f"[Config] Target API: {api_url}")
    print(f"[Config] Credentials: {credentials_path}")

    if not os.path.exists(credentials_path):
        print(f"[Error] Credentials file not found: {credentials_path}", file=sys.stderr)
        sys.exit(1)

    # 1. list-topics でトピックIDを取得
    print("\n--- [Test 1] CLI list-topics ---")
    topics_out = run_cli(["list-topics", "--api-url", api_url, "--credentials", credentials_path])
    topic_match = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", topics_out, re.IGNORECASE)
    topic_id = topic_match.group(1) if topic_match else "231b6f11-81aa-43e6-967d-676df06f211a"
    print(f"  Identified Topic ID: {topic_id}")
    print("  [PASS] CLI list-topics executed successfully")

    # 2. list-posts でスレッドIDを取得
    print("\n--- [Test 2] CLI list-posts ---")
    posts_out = run_cli(["list-posts", "--api-url", api_url, "--credentials", credentials_path, "--limit", "3"])
    post_match = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", posts_out, re.IGNORECASE)
    post_id = post_match.group(1) if post_match else ""
    print(f"  Identified Post ID: {post_id or 'none'}")
    print("  [PASS] CLI list-posts executed successfully")

    # 3. post (Dry-Run)
    print("\n--- [Test 3] CLI post --dry-run ---")
    post_dry_out = run_cli([
        "post",
        "--api-url", api_url,
        "--credentials", credentials_path,
        "--topic", topic_id,
        "--title", "Dry Run Python CLI Automated Test",
        "--content", "Testing dry-run via Python CLI test script",
        "--dry-run",
    ])
    if "[DRY-RUN]" not in post_dry_out and "Validation successful" not in post_dry_out:
        raise RuntimeError(f"Dry run output missing expected message:\n{post_dry_out}")
    print("  [PASS] CLI post --dry-run validated successfully!")

    # 4. comment (Dry-Run)
    if post_id:
        print("\n--- [Test 4] CLI comment --dry-run ---")
        comment_dry_out = run_cli([
            "comment",
            "--api-url", api_url,
            "--credentials", credentials_path,
            "--post-id", post_id,
            "--content", "Testing comment dry-run via Python CLI test script",
            "--dry-run",
        ])
        if "[DRY-RUN]" not in comment_dry_out and "Validation successful" not in comment_dry_out:
            raise RuntimeError(f"Dry run output missing expected message:\n{comment_dry_out}")
        print("  [PASS] CLI comment --dry-run validated successfully!")

    # 5. vote (Dry-Run)
    if post_id:
        print("\n--- [Test 5] CLI vote --dry-run ---")
        vote_dry_out = run_cli([
            "vote",
            "--api-url", api_url,
            "--credentials", credentials_path,
            "--target-type", "post",
            "--target-id", post_id,
            "--vote-type", "up",
            "--dry-run",
        ])
        if "[DRY-RUN]" not in vote_dry_out and "Validation successful" not in vote_dry_out:
            raise RuntimeError(f"Dry run output missing expected message:\n{vote_dry_out}")
        print("  [PASS] CLI vote --dry-run validated successfully!")

    # 6. shoutout send (Dry-Run)
    print("\n--- [Test 6] CLI shoutout send --dry-run ---")
    shoutout_dry_out = run_cli([
        "shoutout", "send",
        "--api-url", api_url,
        "--credentials", credentials_path,
        "--type", "INSTANT",
        "--content", "Testing shoutout dry-run via Python CLI test script",
        "--dry-run",
    ])
    if "[DRY-RUN]" not in shoutout_dry_out and "Simulation only" not in shoutout_dry_out:
        raise RuntimeError(f"Dry run output missing expected message:\n{shoutout_dry_out}")
    print("  [PASS] CLI shoutout send --dry-run validated successfully!")

    # 7. report (Dry-Run)
    if post_id:
        print("\n--- [Test 7] CLI report --dry-run ---")
        report_dry_out = run_cli([
            "report",
            "--api-url", api_url,
            "--credentials", credentials_path,
            "--target-type", "post",
            "--target-id", post_id,
            "--reason", "spam",
            "--detail", "Testing report dry-run via Python CLI test script",
            "--dry-run",
        ])
        if "[DRY-RUN]" not in report_dry_out and "Validation successful" not in report_dry_out:
            raise RuntimeError(f"Dry run output missing expected message:\n{report_dry_out}")
        print("  [PASS] CLI report --dry-run validated successfully!")

    print("\n=================================================")
    print("  [SUCCESS] All Python CLI Dry-Runs Passed!    ")
    print("=================================================")


if __name__ == "__main__":
    main()
