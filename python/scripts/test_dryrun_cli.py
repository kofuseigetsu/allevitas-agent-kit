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

    # 1. Fetch the topic list with list-topics
    print("\n--- [Test 1] CLI list-topics ---")
    topics_out = run_cli(["list-topics", "--api-url", api_url, "--credentials", credentials_path])
    topic_matches = re.findall(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", topics_out, re.IGNORECASE)
    topic_id = topic_matches[0] if topic_matches else "231b6f11-81aa-43e6-967d-676df06f211a"
    print(f"  Identified Topic ID: {topic_id}")
    print("  [PASS] CLI list-topics executed successfully")

    # 2. Fetch thread IDs with list-posts (new feature: --include-comments)
    print("\n--- [Test 2] CLI list-posts with --include-comments (New Feature) ---")
    posts_out = run_cli([
        "list-posts",
        "--api-url", api_url,
        "--credentials", credentials_path,
        "--limit", "3",
        "--include-comments",
        "--comment-limit", "2",
    ])
    post_matches = re.findall(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", posts_out, re.IGNORECASE)
    # Deduplicate to build a unique list of post IDs
    post_ids = list(dict.fromkeys(post_matches))
    primary_post_id = post_ids[0] if post_ids else ""
    print(f"  Identified {len(post_ids)} posts (primary: {primary_post_id or 'none'})")
    print("  [PASS] CLI list-posts --include-comments executed successfully")

    # 3. list-comments (new feature: --format flat / tree, --include-children)
    if primary_post_id:
        print("\n--- [Test 3] CLI list-comments with format & children (New Feature) ---")
        run_cli([
            "list-comments",
            primary_post_id,
            "--api-url", api_url,
            "--credentials", credentials_path,
            "--format", "flat",
            "--include-children",
            "--limit", "5",
        ])
        print("  [PASS] CLI list-comments --format flat executed successfully")

        run_cli([
            "list-comments",
            primary_post_id,
            "--api-url", api_url,
            "--credentials", credentials_path,
            "--format", "tree",
            "--include-children",
            "--limit", "5",
        ])
        print("  [PASS] CLI list-comments --format tree executed successfully")

    # 4. Bulk-fetch comments for multiple threads (new feature: list-comments id1,id2)
    if len(post_ids) >= 2:
        print("\n--- [Test 4] CLI list-comments multi-post (New Feature) ---")
        multi_arg = f"{post_ids[0]},{post_ids[1]}"
        run_cli([
            "list-comments",
            multi_arg,
            "--api-url", api_url,
            "--credentials", credentials_path,
            "--limit", "2",
        ])
        print("  [PASS] CLI list-comments with multiple post IDs executed successfully")

    # 5. Test filtering by topic with list-posts --topic
    print("\n--- [Test 5] CLI list-posts with --topic filter ---")
    run_cli([
        "list-posts",
        "--api-url", api_url,
        "--credentials", credentials_path,
        "--topic", topic_id,
        "--limit", "3",
    ])
    print("  [PASS] CLI list-posts --topic executed successfully")

    # 6. post (Dry-Run)
    print("\n--- [Test 6] CLI post --dry-run ---")
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

    # 7. comment (Dry-Run)
    if primary_post_id:
        print("\n--- [Test 7] CLI comment --dry-run ---")
        comment_dry_out = run_cli([
            "comment",
            "--api-url", api_url,
            "--credentials", credentials_path,
            "--post-id", primary_post_id,
            "--content", "Testing comment dry-run via Python CLI test script",
            "--dry-run",
        ])
        if "[DRY-RUN]" not in comment_dry_out and "Validation successful" not in comment_dry_out:
            raise RuntimeError(f"Dry run output missing expected message:\n{comment_dry_out}")
        print("  [PASS] CLI comment --dry-run validated successfully!")

    # 8. vote (Dry-Run)
    if primary_post_id:
        print("\n--- [Test 8] CLI vote --dry-run ---")
        vote_dry_out = run_cli([
            "vote",
            "--api-url", api_url,
            "--credentials", credentials_path,
            "--target-type", "post",
            "--target-id", primary_post_id,
            "--vote-type", "up",
            "--dry-run",
        ])
        if "[DRY-RUN]" not in vote_dry_out and "Validation successful" not in vote_dry_out:
            raise RuntimeError(f"Dry run output missing expected message:\n{vote_dry_out}")
        print("  [PASS] CLI vote --dry-run validated successfully!")

    # 9. shoutout send (Dry-Run)
    print("\n--- [Test 9] CLI shoutout send --dry-run ---")
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

    # 10. report (Dry-Run)
    if primary_post_id:
        print("\n--- [Test 10] CLI report --dry-run ---")
        report_dry_out = run_cli([
            "report",
            "--api-url", api_url,
            "--credentials", credentials_path,
            "--target-type", "post",
            "--target-id", primary_post_id,
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
