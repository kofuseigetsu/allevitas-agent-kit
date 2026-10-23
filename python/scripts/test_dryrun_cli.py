import argparse
import json
import os
import re
import subprocess
import sys

current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)


def localized_api_url(api_url):
    """Return the /ja/api/ variant of api_url, or None when it does not end with /api."""
    base = api_url.rstrip("/")
    if not base.endswith("/api"):
        return None
    return base[: -len("/api")] + "/ja/api/"


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


def run_cli_result(cli_args, cwd=parent_dir):
    cmd = [sys.executable, "-m", "allevitas.cli"] + cli_args
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def run_cli(cli_args, cwd=parent_dir):
    cmd = [sys.executable, "-m", "allevitas.cli"] + cli_args
    res = run_cli_result(cli_args, cwd=cwd)
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
    primary_comment_id = ""
    if primary_post_id:
        print("\n--- [Test 3] CLI list-comments with format & children (New Feature) ---")
        flat_comments_out = run_cli([
            "list-comments",
            primary_post_id,
            "--api-url", api_url,
            "--credentials", credentials_path,
            "--format", "flat",
            "--include-children",
            "--limit", "5",
        ])
        print("  [PASS] CLI list-comments --format flat executed successfully")
        comment_matches = re.findall(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", flat_comments_out, re.IGNORECASE)
        # Exclude the primary_post_id from matches to identify comment ID
        candidate_cids = [m for m in comment_matches if m.lower() != primary_post_id.lower()]
        primary_comment_id = candidate_cids[0] if candidate_cids else ""

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

        # 7.1 get-comment (New Feature)
        print("\n--- [Test 7.1] CLI get-comment (New Feature) ---")
        if primary_comment_id:
            print(f"  Testing get-comment with ID {primary_comment_id}...")
            get_comment_out = run_cli([
                "get-comment",
                primary_post_id,
                primary_comment_id,
                "--api-url", api_url,
                "--credentials", credentials_path,
            ])
            assert primary_comment_id in get_comment_out, f"Comment ID not in output: {get_comment_out}"
            print("  [PASS] CLI get-comment executed successfully")

            # Also verify JSON output format
            get_comment_json = run_cli([
                "get-comment",
                primary_post_id,
                primary_comment_id,
                "--api-url", api_url,
                "--credentials", credentials_path,
                "--json",
            ])
            parsed = json.loads(get_comment_json)
            assert parsed.get("id") == primary_comment_id, f"JSON parsed ID mismatch: {parsed}"
            print("  [PASS] CLI get-comment --json format validated successfully!")
        else:
            print("  [INFO] No comment found on target thread to test get-comment CLI.")

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

    # 11. guidelines (New Feature)
    print("\n--- [Test 11] CLI guidelines ---")
    guidelines_out = run_cli([
        "guidelines",
        "--api-url", api_url,
        "--lang", "ja",
    ])
    if "コミュニティガイドライン" not in guidelines_out and "Guidelines" not in guidelines_out:
        raise RuntimeError(f"Guidelines output does not contain expected title:\n{guidelines_out}")
    print("  [PASS] CLI guidelines text format validated successfully!")

    # Verify guidelines JSON format
    guidelines_json_out = run_cli([
        "guidelines",
        "--api-url", api_url,
        "--lang", "en",
        "--json",
    ])
    parsed_guidelines = json.loads(guidelines_json_out)
    if not parsed_guidelines.get("guidelines") and not parsed_guidelines.get("data"):
        raise RuntimeError(f"CLI guidelines --json missing guidelines/data:\n{guidelines_json_out}")
    print("  [PASS] CLI guidelines --json format validated successfully!")

    # 12. URL Normalization check (/ja/api -> /api) via CLI
    print("\n--- [Test 12] CLI URL Normalization (/ja/api -> /api) ---")
    # Derive the localized URL from --api-url so the check never leaves the target environment
    localized_url = localized_api_url(api_url)
    if localized_url is None:
        print(f"  [INFO] {api_url} does not end with /api. Skipping URL normalization check.")
    else:
        normalized_cli_out = run_cli([
            "guidelines",
            "--api-url", localized_url,
            "--json",
        ])
        parsed_norm = json.loads(normalized_cli_out)
        if not parsed_norm.get("guidelines") and not parsed_norm.get("data"):
            raise RuntimeError(f"CLI URL normalization request failed:\n{normalized_cli_out}")
        print(f"  [PASS] CLI with {localized_url} normalized to /api and retrieved real API data successfully!")

    # 13. Board (Tabula Canvas) Dry-Run & Retrieval
    if primary_post_id:
        print("\n--- [Test 13] CLI board get & dry-run operations ---")
        try:
            board_get_out = run_cli([
                "board", "get", primary_post_id,
                "--api-url", api_url,
                "--credentials", credentials_path,
                "--json",
            ])
            parsed_board = json.loads(board_get_out)
            print(f"  Fetched Board: postId={parsed_board.get('postId')}, version={parsed_board.get('version')}")
            print("  [PASS] CLI board get executed successfully")

            board_lock_dry = run_cli([
                "board", "lock", primary_post_id,
                "--api-url", api_url,
                "--credentials", credentials_path,
                "--dry-run",
            ])
            if "[DRY-RUN]" not in board_lock_dry and "Simulation only" not in board_lock_dry:
                raise RuntimeError(f"Board lock dry-run output missing expected message:\n{board_lock_dry}")
            print("  [PASS] CLI board lock --dry-run validated successfully!")

            board_history_out = run_cli([
                "board", "history", primary_post_id,
                "--api-url", api_url,
                "--credentials", credentials_path,
                "--limit", "3",
                "--json",
            ])
            parsed_history = json.loads(board_history_out)
            total_history = parsed_history.get("pagination", {}).get("total", 0)
            print(f"  Fetched Board History: total={total_history}")
            print("  [PASS] CLI board history executed successfully")
        except Exception as e:
            if "BoardDisabledError" in str(e) or "503" in str(e) or "BOARD_API_DISABLED" in str(e):
                print(f"  [INFO] Board feature is currently disabled (503 BOARD_API_DISABLED) on remote server.")
            else:
                raise

    # 14. Board update with automatic diff (Dry-Run)
    if primary_post_id:
        print("\n--- [Test 14] CLI board update with automatic diff (Dry-Run) ---")
        try:
            run_board_update_dry_run_tests(api_url, credentials_path, primary_post_id)
        except Exception as e:
            if "BoardDisabledError" in str(e) or "503" in str(e) or "BOARD_API_DISABLED" in str(e):
                print(f"  [INFO] Board feature is currently disabled (503 BOARD_API_DISABLED) on remote server.")
            else:
                raise

    print("\n=================================================")
    print("  [SUCCESS] All Python CLI Dry-Runs Passed!    ")
    print("=================================================")


def get_board_json(api_url, credentials_path, post_id):
    return json.loads(run_cli([
        "board", "get", post_id,
        "--api-url", api_url,
        "--credentials", credentials_path,
        "--json",
    ]))


def find_board_with_content(api_url, credentials_path, fallback_post_id, max_posts=10):
    """Return the first post ID whose board has content (read-only), or the fallback."""
    posts_out = run_cli([
        "list-posts",
        "--api-url", api_url,
        "--credentials", credentials_path,
        "--limit", str(max_posts),
    ])
    uuid_pattern = r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    for post_id in dict.fromkeys(re.findall(uuid_pattern, posts_out, re.IGNORECASE)):
        res = run_cli_result([
            "board", "get", post_id,
            "--api-url", api_url,
            "--credentials", credentials_path,
            "--json",
        ])
        if res.returncode != 0:
            continue  # Not a post ID (e.g. a topic ID in the listing)
        if json.loads(res.stdout).get("content"):
            return post_id
    return fallback_post_id


def run_board_update_dry_run_tests(api_url, credentials_path, fallback_post_id):
    post_id = find_board_with_content(api_url, credentials_path, fallback_post_id)
    board = get_board_json(api_url, credentials_path, post_id)
    current = (board.get("content") or "").replace("\r\n", "\n")
    version = int(board.get("version", 0))
    print(f"  Target Board: postId={post_id}, version={version}, length={len(current)}")

    base_args = [
        "board", "update", post_id,
        "--api-url", api_url,
        "--credentials", credentials_path,
        "--dry-run",
    ]

    # 14.1 Full content is committed as an automatic diff
    separator = "" if current == "" or current.endswith("\n") else "\n"
    new_content = f"{current}{separator}- Python CLI dry-run line\n"
    out = run_cli(base_args + ["-m", "Python CLI dry-run board update", "--content", new_content, "--version", str(version), "--json"])
    data = json.loads(out[out.index("{"):])
    if data.get("changed") is not True or data.get("dryRun") is not True:
        raise RuntimeError(f"Expected changed/dryRun=true, got:\n{out}")
    print(f"  Result: changed={data.get('changed')}, dryRun={data.get('dryRun')}, version={data.get('version')}")
    print("  [PASS] CLI board update --content --dry-run validated by the server!")

    # 14.2 Unchanged content is a no-op
    out = run_cli(base_args + ["-m", "No change", "--content", current])
    if "Board unchanged (no commit)" not in out:
        raise RuntimeError(f"Expected no-op message, got:\n{out}")
    print("  [PASS] CLI reported 'Board unchanged (no commit)' for unchanged content!")

    # 14.3 Stale --version is rejected
    res = run_cli_result(base_args + ["-m", "Stale", "--content", new_content, "--version", str(version - 1)])
    if res.returncode == 0 or "version" not in res.stderr.lower():
        raise RuntimeError(f"Expected a version conflict error, got code {res.returncode}:\n{res.stdout}\n{res.stderr}")
    print("  [PASS] CLI rejected a stale --version!")

    # 14.4 Clearing a non-empty board requires --replace-all
    if current:
        res = run_cli_result(base_args + ["-m", "Clear", "--content", ""])
        if res.returncode == 0:
            raise RuntimeError(f"Expected clearing without --replace-all to fail:\n{res.stdout}")
        print("  [PASS] CLI rejected clearing the board without --replace-all!")

    # 14.5 Nothing was persisted
    after = get_board_json(api_url, credentials_path, post_id)
    if int(after.get("version", 0)) != version or (after.get("content") or "") != (board.get("content") or ""):
        raise RuntimeError("Board changed during dry-run")
    print("  [PASS] Board content and version are unchanged after dry-run!")


if __name__ == "__main__":
    main()
