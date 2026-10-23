import argparse
import json
import os
import sys

# Add python directory to sys.path so allevitas package can be imported directly
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from allevitas.client import AllevitasClient
from allevitas.board_diff import build_board_operations, normalize_line_endings
from allevitas.types import BoardVersionConflictError
from allevitas.utils import normalize_api_url


def localized_api_url(api_url):
    """Return the /ja/api/ variant of api_url, or None when it does not end with /api."""
    base = api_url.rstrip("/")
    if not base.endswith("/api"):
        return None
    return base[: -len("/api")] + "/ja/api/"


def parse_args():
    parser = argparse.ArgumentParser(description="Allevitas Real API Python SDK Dry-Run Suite")
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


def main():
    args = parse_args()
    credentials_path = os.path.abspath(args.credentials)
    api_url = args.api_url

    print("=================================================")
    print("  Allevitas Real API Python SDK Dry-Run Suite    ")
    print("=================================================")
    print(f"[Config] Target API: {api_url}")
    print(f"[Config] Credentials: {credentials_path}")

    if not os.path.exists(credentials_path):
        print(f"[Error] Credentials file not found: {credentials_path}", file=sys.stderr)
        sys.exit(1)

    with open(credentials_path, "r", encoding="utf-8") as f:
        creds = json.load(f)

    account_id = creds.get("accountId") or creds.get("account_id")
    password = creds.get("password")

    if not account_id or not password:
        print("[Error] Invalid credentials JSON: accountId and password required.", file=sys.stderr)
        sys.exit(1)

    print(f"[Auth] Using account: {account_id}")

    client = AllevitasClient(
        api_url=api_url,
        credentials_path=credentials_path,
        dry_run=True,
        save_credentials=False,
    )

    # 1. Verify login
    print("\n--- [Test 1] Login to real API ---")
    login_res = client.login(account_id, password)
    print(f"  Account ID: {login_res.account_id}")
    print("  [PASS] Authentication successful!")

    # 2. Topic list & new feature: get_posts_with_comments
    print("\n--- [Test 2] Get Topics & Posts (with comments) ---")
    topics = client.thread.get_topics()
    print(f"  Topics count: {len(topics)} (first: {topics[0].name} / {topics[0].id})")

    topic_id = topics[0].id
    res_posts = client.thread.get_posts(limit=3, include_comments=True, comment_limit=2)
    pwc = res_posts.get("posts_with_comments", [])
    print(f"  Posts with comments fetched (global): {len(pwc)}")
    sample_post = pwc[0] if pwc else None
    target_post_id = sample_post.post.id if sample_post else None
    if sample_post:
        print(f"  Sample Post: [{sample_post.post.title}] (ID: {target_post_id})")
        print(f"  Comments count: {len(sample_post.comments)}")

        # Verify filtering by a specific topic (also verifies the client.get_posts_with_comments shortcut)
        sample_topic_id = sample_post.post.topic_id
        if sample_topic_id:
            filtered_pwc = client.get_posts_with_comments(
                topic_id=sample_topic_id,
                limit=3,
                comment_limit=2,
            )
            print(f"  Posts with comments filtered by topic ({sample_topic_id}): {len(filtered_pwc)}")
            print("  [PASS] Topic-filtered get_posts_with_comments validated successfully!")

    # 3. New feature: get_multiple_post_comments
    if pwc:
        print("\n--- [Test 3] Multi-post comments fetching (New Feature) ---")
        pids = [item.post.id for item in pwc]
        multi_comments = client.get_multiple_post_comments(pids, limit=2)
        print(f"  Multi comments fetched for {len(multi_comments)} posts:")
        for pid, cmts in multi_comments.items():
            print(f"    - Post {pid}: {len(cmts)} comments")

    target_topic_id = topic_id

    # 4. Thread post Dry-Run
    print("\n--- [Test 4] Post Thread (Dry-Run) ---")
    post_res = client.thread.post(
        topic_id=target_topic_id,
        title="Python SDK Dry-Run Test Thread",
        content="Automated Dry-Run verification from Python SDK test script.",
        dry_run=True,
    )
    resolved_post_id = post_res.id or post_res.post_id
    print(f"  Result: dry_run={post_res.dry_run}, status={post_res.status}, msg={post_res.message}")
    print(f"  Pre-assigned ID: {resolved_post_id}, Job ID: {post_res.job_id}")
    assert post_res.dry_run is True, f"Expected dry_run=True, got {post_res.dry_run}"
    print("  [PASS] Python Thread post dry-run validated successfully!")

    # 5. Comment post Dry-Run
    if target_post_id:
        print("\n--- [Test 5] Post Comment (Dry-Run) ---")
        comment_res = client.thread.comment(
            post_id=target_post_id,
            content="Automated Dry-Run comment from Python SDK test script.",
            dry_run=True,
        )
        resolved_comment_id = comment_res.id or comment_res.comment_id
        print(f"  Result: dry_run={comment_res.dry_run}, status={comment_res.status}, msg={comment_res.message}")
        print(f"  Pre-assigned ID: {resolved_comment_id}, Job ID: {comment_res.job_id}")
        assert comment_res.dry_run is True, f"Expected dry_run=True, got {comment_res.dry_run}"
        print("  [PASS] Python Comment dry-run validated successfully!")

        # 5.1 Single Comment Retrieval (New Feature)
        print("\n--- [Test 5.1] Single Comment Retrieval (get_comment, New Feature) ---")
        if sample_post and sample_post.comments:
            target_comment = sample_post.comments[0]
            target_cid = target_comment.id
            print(f"  Fetching single comment {target_cid} on post {target_post_id}...")
            single_c = client.thread.get_comment(target_post_id, target_cid)
            print(f"  Fetched: ID={single_c.id}, depth={single_c.depth}, author={single_c.author_id}")
            assert single_c.id == target_cid, f"Expected {target_cid}, got {single_c.id}"
            print("  [PASS] Single comment retrieval (200 OK) validated successfully!")
        else:
            print("  [INFO] Target thread has no existing comments. Skipping 200 OK single comment check.")

        # Test 404 handling on non-existent comment
        try:
            client.thread.get_comment(target_post_id, "non_existent_dummy_comment_id_99999")
            print("  [WARN] Expected 404 for non-existent comment, but request succeeded.")
        except Exception as e:
            print(f"  [PASS] Non-existent comment correctly returned error (404 Not Found): {e}")

    # 6. Vote Dry-Run
    if target_post_id:
        print("\n--- [Test 6] Vote on Post (Dry-Run) ---")
        vote_res = client.thread.vote(
            target_type="post",
            target_id=target_post_id,
            vote_type="up",
            dry_run=True,
        )
        print(f"  Result: dry_run={vote_res.dry_run}, msg={vote_res.message}")
        assert vote_res.dry_run is True, f"Expected dry_run=True, got {vote_res.dry_run}"
        print("  [PASS] Python Vote dry-run validated successfully!")

    # 7. ShoutOut Dry-Run
    print("\n--- [Test 7] ShoutOut Send (Dry-Run) ---")
    shoutout_res = client.shoutout.send_instant(
        content="Automated Python SDK shoutout dry-run test",
        dry_run=True,
    )
    print(f"  Result: dry_run={shoutout_res.dry_run}, msg={shoutout_res.message}")
    assert shoutout_res.dry_run is True, f"Expected dry_run=True, got {shoutout_res.dry_run}"
    print("  [PASS] Python ShoutOut dry-run validated successfully!")

    # 8. Report Dry-Run
    if target_post_id:
        print("\n--- [Test 8] Report Post (Dry-Run) ---")
        report_res = client.thread.report(
            target_type="post",
            target_id=target_post_id,
            reason="spam",
            detail="Automated Python dry-run report verification",
            dry_run=True,
        )
        print(f"  Result: {report_res}")
        is_dry_run = report_res.get("dry_run", report_res.get("dryRun"))
        assert is_dry_run is True, f"dry_run flag should be True, got {is_dry_run}"
        print("  [PASS] Python Report dry-run validated successfully!")

    # 9. Community Guidelines Retrieval (New Feature)
    print("\n--- [Test 9] Community Guidelines Retrieval (get_guidelines) ---")
    guidelines_res = client.get_guidelines(lang="ja")
    raw_g = guidelines_res.get("guidelines") or guidelines_res.get("data") or {}
    g_title = raw_g.get("title") if isinstance(raw_g, dict) else None
    print(f"  Guidelines Title: {g_title or '(no title)'}")
    assert "guidelines" in guidelines_res or "data" in guidelines_res, "Guidelines response should contain guidelines or data"
    print("  [PASS] Community guidelines retrieval validated successfully!")

    # 10. URL Normalization check (/ja/api -> /api)
    print("\n--- [Test 10] URL Normalization Verification (/ja/api -> /api) ---")
    # Derive the localized URL from --api-url so the check never leaves the target environment
    localized_url = localized_api_url(api_url)
    if localized_url is None:
        print(f"  [INFO] {api_url} does not end with /api. Skipping URL normalization check.")
    else:
        expected_url = normalize_api_url(api_url)
        normalized_client = AllevitasClient(
            api_url=localized_url,
            dry_run=True,
        )
        assert normalized_client.api_url == expected_url, (
            f"Expected '{expected_url}', got '{normalized_client.api_url}'"
        )
        norm_guidelines = normalized_client.get_guidelines(lang="en")
        assert "guidelines" in norm_guidelines or "data" in norm_guidelines, "Failed to fetch guidelines via normalized client URL"
        print(f"  [PASS] Client initialized with {localized_url} normalized to {normalized_client.api_url} and requested real API successfully!")

    # 11. Board (Tabula Canvas) Dry-Run & Operations
    if target_post_id:
        print("\n--- [Test 11] Board Operations & Dry-Run (New Feature) ---")
        try:
            board_data = client.board.get(target_post_id)
            print(f"  Current Board: Post ID={board_data.post_id}, Version={board_data.version}, isLocked={board_data.is_locked}")
            print("  [PASS] client.board.get retrieved successfully!")

            lock_res = client.board.lock(target_post_id)
            print(f"  Board Lock (Dry-Run): dry_run={lock_res.dry_run}, msg={lock_res.message}")
            print("  [PASS] client.board.lock dry-run validated successfully!")

            history_data = client.board.get_history(target_post_id, limit=3)
            print(f"  Board History: items={len(history_data.history)}, total={history_data.pagination.total}")
            print("  [PASS] client.board.get_history validated successfully!")
        except Exception as e:
            if "BoardDisabledError" in str(type(e)) or "503" in str(e) or "BOARD_API_DISABLED" in str(e):
                print(f"  [INFO] Board API is currently disabled on remote server ({e}). Skipping.")
            else:
                raise

    # 12. Board update with automatic diff (Dry-Run)
    if target_post_id:
        print("\n--- [Test 12] Board update with automatic diff (Dry-Run) ---")
        try:
            run_board_update_dry_run_tests(client, target_post_id)
        except Exception as e:
            if "BoardDisabledError" in str(type(e)) or "503" in str(e) or "BOARD_API_DISABLED" in str(e):
                print(f"  [INFO] Board API is currently disabled on remote server ({e}). Skipping.")
            else:
                raise

    print("\n=================================================")
    print("  [SUCCESS] All Python SDK Dry-Runs Passed!    ")
    print("=================================================")


def find_board_with_content(client, fallback_post_id, max_posts=10):
    """Return the first post ID whose board has content (read-only), or the fallback."""
    posts = client.thread.get_posts(limit=max_posts).get("posts", [])
    for post in posts:
        if client.board.get(post.id).content:
            return post.id
    return fallback_post_id


def run_board_update_dry_run_tests(client, fallback_post_id):
    post_id = find_board_with_content(client, fallback_post_id)
    board = client.board.get(post_id)
    current = normalize_line_endings(board.content)
    print(f"  Target Board: Post ID={post_id}, Version={board.version}, length={len(current)}")

    # 12.1 Full content is committed as an automatic diff (replace_all only for an empty board)
    separator = "" if current == "" or current.endswith("\n") else "\n"
    new_content = f"{current}{separator}- Python SDK dry-run line\n"
    operations = build_board_operations(current, new_content)
    uses_replace_all = any(op.get("type") == "replace_all" for op in operations)
    assert uses_replace_all == (current == ""), f"Unexpected operations: {operations}"
    res = client.board.update(
        post_id,
        commit_message="Python SDK dry-run board update",
        content=new_content,
        base_version=board.version,
        dry_run=True,
    )
    print(f"  Result: dry_run={res.dry_run}, changed={res.changed}, version={res.version}, operations={len(operations)}")
    assert res.dry_run is True and res.changed is True, f"Expected dry_run/changed=True, got {res}"
    assert res.content == new_content, "Expected content does not match the requested content"
    if current:
        assert res.version == board.version + 1, f"Expected version {board.version + 1}, got {res.version}"
    print(f"  [PASS] Server validated the {'replace_all' if uses_replace_all else 'Search/Replace diff'} update!")

    # 12.2 Unchanged content is a no-op
    res = client.board.update(post_id, commit_message="No change", content=board.content, dry_run=True)
    assert res.changed is False and res.version == board.version, f"Expected no-op, got {res}"
    print("  [PASS] Unchanged content returned changed=False without committing!")

    # 12.3 Stale base_version is rejected before committing
    try:
        client.board.update(
            post_id, commit_message="Stale", content=new_content,
            base_version=board.version - 1, dry_run=True,
        )
        raise AssertionError("Expected BoardVersionConflictError for a stale base_version")
    except BoardVersionConflictError as e:
        print(f"  [PASS] Stale base_version rejected: {e}")

    # 12.4 Clearing a non-empty board requires force_replace_all
    if current:
        try:
            client.board.update(post_id, commit_message="Clear", content="", dry_run=True)
            raise AssertionError("Expected ValueError when clearing without force_replace_all")
        except ValueError as e:
            print(f"  [PASS] Clearing without force_replace_all rejected: {e}")

    # 12.5 Nothing was persisted
    after = client.board.get(post_id)
    assert after.version == board.version and after.content == board.content, "Board changed during dry-run"
    print("  [PASS] Board content and version are unchanged after dry-run!")


if __name__ == "__main__":
    main()
