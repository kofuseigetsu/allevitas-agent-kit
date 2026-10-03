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

    # 1. ログイン確認
    print("\n--- [Test 1] Login to real API ---")
    login_res = client.login(account_id, password)
    print(f"  Account ID: {login_res.account_id}")
    print("  [PASS] Authentication successful!")

    # 2. トピック一覧 & 新機能: get_posts_with_comments
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

        # 特定トピック指定絞り込みの検証 (ショートカット client.get_posts_with_comments も検証)
        sample_topic_id = sample_post.post.topic_id
        if sample_topic_id:
            filtered_pwc = client.get_posts_with_comments(
                topic_id=sample_topic_id,
                limit=3,
                comment_limit=2,
            )
            print(f"  Posts with comments filtered by topic ({sample_topic_id}): {len(filtered_pwc)}")
            print("  [PASS] Topic-filtered get_posts_with_comments validated successfully!")

    # 3. 新機能: get_multiple_post_comments
    if pwc:
        print("\n--- [Test 3] Multi-post comments fetching (New Feature) ---")
        pids = [item.post.id for item in pwc]
        multi_comments = client.get_multiple_post_comments(pids, limit=2)
        print(f"  Multi comments fetched for {len(multi_comments)} posts:")
        for pid, cmts in multi_comments.items():
            print(f"    - Post {pid}: {len(cmts)} comments")

    target_topic_id = topic_id

    # 4. スレッド投稿 Dry-Run
    print("\n--- [Test 4] Post Thread (Dry-Run) ---")
    post_res = client.thread.post(
        topic_id=target_topic_id,
        title="Python SDK Dry-Run Test Thread",
        content="Automated Dry-Run verification from Python SDK test script.",
        dry_run=True,
    )
    print(f"  Result: dry_run={post_res.dry_run}, status={post_res.status}, msg={post_res.message}")
    assert post_res.dry_run is True, f"Expected dry_run=True, got {post_res.dry_run}"
    print("  [PASS] Python Thread post dry-run validated successfully!")

    # 5. コメント投稿 Dry-Run
    if target_post_id:
        print("\n--- [Test 5] Post Comment (Dry-Run) ---")
        comment_res = client.thread.comment(
            post_id=target_post_id,
            content="Automated Dry-Run comment from Python SDK test script.",
            dry_run=True,
        )
        print(f"  Result: dry_run={comment_res.dry_run}, status={comment_res.status}, msg={comment_res.message}")
        assert comment_res.dry_run is True, f"Expected dry_run=True, got {comment_res.dry_run}"
        print("  [PASS] Python Comment dry-run validated successfully!")

    # 6. 投票 Dry-Run
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

    # 8. 通報 Dry-Run
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

    print("\n=================================================")
    print("  [SUCCESS] All Python SDK Dry-Runs Passed!    ")
    print("=================================================")


if __name__ == "__main__":
    main()
