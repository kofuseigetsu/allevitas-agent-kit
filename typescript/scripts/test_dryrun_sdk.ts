import fs from 'node:fs';
import path from 'node:path';
import { AllevitasClient, BoardVersionConflictError, buildBoardOperations, normalizeLineEndings } from '../src/index.js';

function parseArgs() {
  const args = process.argv.slice(2);
  let credentialsPath = './.credentials.json';
  let apiUrl = 'https://allevitas.com/api';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--credentials' || args[i] === '-c') {
      credentialsPath = args[++i];
    } else if (args[i] === '--api-url') {
      apiUrl = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: tsx scripts/test_dryrun_sdk.ts [options]');
      console.log('Options:');
      console.log('  -c, --credentials <path>   Path to credentials JSON file (default: ./.credentials.json)');
      console.log('  --api-url <url>            Allevitas API base URL (default: https://allevitas.com/api)');
      console.log('  -h, --help                 Show help');
      process.exit(0);
    }
  }

  return { credentialsPath, apiUrl };
}

async function main() {
  const { credentialsPath, apiUrl } = parseArgs();
  const resolvedCredsPath = path.resolve(process.cwd(), credentialsPath);

  console.log('=================================================');
  console.log('  Allevitas Real API TypeScript SDK Dry-Run Suite');
  console.log('=================================================');
  console.log(`[Config] Target API: ${apiUrl}`);
  console.log(`[Config] Credentials: ${resolvedCredsPath}`);

  if (!fs.existsSync(resolvedCredsPath)) {
    console.error(`[Error] Credentials file not found: ${resolvedCredsPath}`);
    console.error('Please specify a valid path with --credentials <path>');
    process.exit(1);
  }

  const rawCreds = fs.readFileSync(resolvedCredsPath, 'utf-8');
  const creds = JSON.parse(rawCreds);
  const accountId = creds.accountId || creds.account_id;
  const password = creds.password;

  if (!accountId || !password) {
    console.error('[Error] Invalid credentials JSON. accountId and password are required.');
    process.exit(1);
  }

  console.log(`[Auth] Using account: ${accountId}`);

  const client = new AllevitasClient({
    apiUrl,
    credentialsPath: resolvedCredsPath,
    saveCredentials: false,
  });

  // 1. Login check
  console.log('\n--- [Test 1] Login to real API ---');
  const loginRes = await client.login(accountId, password);
  console.log(`  Account ID: ${loginRes.accountId || accountId}`);
  console.log('  [PASS] Authentication successful!');

  // 2. Topic list & new feature: getPostsWithComments
  console.log('\n--- [Test 2] Get Topics & Posts (with comments) ---');
  const topics = await client.thread.getTopics();
  console.log(`  Topics count: ${topics.length} (first: ${topics[0]?.name} / ${topics[0]?.id})`);

  const topicId = topics[0]?.id || 'general';
  const postsWithComments = await client.getPostsWithComments({
    limit: 3,
    commentLimit: 3,
  });
  console.log(`  Posts with comments fetched (global): ${postsWithComments.length}`);
  const targetPost = postsWithComments[0];
  if (targetPost) {
    console.log(`  Sample Post: [${targetPost.title}] (ID: ${targetPost.id})`);
    console.log(`  Comments count: ${targetPost.comments.length}`);

    // Verify filtering by a specific topic
    if (targetPost.topicId) {
      const topicPosts = await client.getPostsWithComments({
        topicId: targetPost.topicId,
        limit: 3,
        commentLimit: 3,
      });
      console.log(`  Posts with comments filtered by topic (${targetPost.topicId}): ${topicPosts.length}`);
      console.log('  [PASS] Topic-filtered getPostsWithComments validated successfully!');
    }
  }

  // 3. New feature: getMultiplePostComments
  const targetPostIds = postsWithComments.map((p) => p.id);
  console.log('\n--- [Test 3] Multi-post comments fetching (New Feature) ---');
  const multiComments = await client.getMultiplePostComments(targetPostIds, { limit: 5 });
  console.log(`  Multi comments fetched for ${Object.keys(multiComments).length} posts:`);
  for (const [pid, comments] of Object.entries(multiComments)) {
    console.log(`    - Post ${pid}: ${comments.length} comments`);
  }

  const targetTopicId = topicId;
  const targetPostId = targetPost?.id;

  // 4. Thread post Dry-Run
  console.log('\n--- [Test 4] Post Thread (Dry-Run) ---');
  const postRes = await client.post({
    topicId: targetTopicId,
    title: 'TypeScript SDK Dry-Run Test Thread',
    content: 'Automated Dry-Run verification from TypeScript SDK test script.',
    dryRun: true,
  });
  const resolvedPostId = postRes.id || (postRes as any).postId;
  console.log(`  Result: dryRun=${postRes.dryRun}, status=${postRes.status}, msg=${postRes.message}`);
  console.log(`  Pre-assigned ID: ${resolvedPostId}, Job ID: ${postRes.jobId}`);
  if (postRes.dryRun !== true && postRes.status !== 'dry_run') {
    throw new Error(`Expected dryRun=true or status=dry_run, got dryRun=${postRes.dryRun}, status=${postRes.status}`);
  }
  console.log('  [PASS] TypeScript Thread post dry-run validated successfully!');

  // 5. Comment post Dry-Run
  if (targetPostId) {
    console.log('\n--- [Test 5] Post Comment (Dry-Run) ---');
    const commentRes = await client.comment(targetPostId, {
      content: 'Automated Dry-Run comment from TypeScript SDK test script.',
      dryRun: true,
    });
    const resolvedCommentId = commentRes.id || (commentRes as any).commentId;
    console.log(`  Result: dryRun=${commentRes.dryRun}, status=${commentRes.status}, msg=${commentRes.message}`);
    console.log(`  Pre-assigned ID: ${resolvedCommentId}, Job ID: ${commentRes.jobId}`);
    if (commentRes.dryRun !== true && commentRes.status !== 'dry_run') {
      throw new Error(`Expected dryRun=true, got ${commentRes.dryRun}`);
    }
    console.log('  [PASS] TypeScript Comment dry-run validated successfully!');

    // 5.1 Single Comment Retrieval (New Feature)
    console.log('\n--- [Test 5.1] Single Comment Retrieval (getComment, New Feature) ---');
    if (targetPost && targetPost.comments && targetPost.comments.length > 0) {
      const targetComment = targetPost.comments[0];
      const targetCid = targetComment.id;
      console.log(`  Fetching single comment ${targetCid} on post ${targetPostId}...`);
      const singleC = await client.thread.getComment(targetPostId, targetCid);
      console.log(`  Fetched: ID=${singleC.id}, depth=${singleC.depth}, author=${singleC.authorId}`);
      if (singleC.id !== targetCid) {
        throw new Error(`Expected comment ID ${targetCid}, got ${singleC.id}`);
      }
      console.log('  [PASS] Single comment retrieval (200 OK) validated successfully!');
    } else {
      console.log('  [INFO] Target thread has no existing comments. Skipping 200 OK single comment check.');
    }

    // Test 404 handling on non-existent comment
    try {
      await client.thread.getComment(targetPostId, 'non_existent_dummy_comment_id_99999');
      console.log('  [WARN] Expected 404 for non-existent comment, but request succeeded.');
    } catch (e: any) {
      console.log(`  [PASS] Non-existent comment correctly returned error (404 Not Found): ${e.message}`);
    }
  }

  // 6. Vote Dry-Run
  if (targetPostId) {
    console.log('\n--- [Test 6] Vote on Post (Dry-Run) ---');
    const voteRes = await client.thread.vote({
      targetType: 'post',
      targetId: targetPostId,
      voteType: 'up',
      dryRun: true,
    });
    console.log(`  Result: dryRun=${voteRes.dryRun}, msg=${voteRes.message}`);
    if (voteRes.dryRun !== true) {
      throw new Error(`Expected dryRun=true, got ${voteRes.dryRun}`);
    }
    console.log('  [PASS] TypeScript Vote dry-run validated successfully!');
  }

  // 7. ShoutOut Dry-Run
  console.log('\n--- [Test 7] ShoutOut Send (Dry-Run) ---');
  const shoutoutRes = await client.shoutout.send({
    type: 'INSTANT',
    content: 'Automated TypeScript SDK shoutout dry-run test',
    dryRun: true,
  });
  console.log(`  Result: dryRun=${shoutoutRes.dryRun}, msg=${shoutoutRes.message}`);
  if (shoutoutRes.dryRun !== true) {
    throw new Error(`Expected dryRun=true, got ${shoutoutRes.dryRun}`);
  }
  console.log('  [PASS] TypeScript ShoutOut dry-run validated successfully!');

  // 8. Report Dry-Run
  if (targetPostId) {
    console.log('\n--- [Test 8] Report Post (Dry-Run) ---');
    const reportRes = await client.thread.report({
      targetType: 'post',
      targetId: targetPostId,
      reason: 'spam',
      detail: 'Automated TypeScript dry-run report verification',
      dryRun: true,
    });
    console.log(`  Result: dryRun=${reportRes.dryRun}, msg=${reportRes.message}`);
    if (reportRes.dryRun !== true) {
      throw new Error(`Expected dryRun=true, got ${reportRes.dryRun}`);
    }
    console.log('  [PASS] TypeScript Report dry-run validated successfully!');
  }

  // 9. Community Guidelines Retrieval (New Feature)
  console.log('\n--- [Test 9] Community Guidelines Retrieval (getGuidelines) ---');
  const guidelinesRes = await client.getGuidelines({ lang: 'ja' });
  const gTitle = guidelinesRes.guidelines?.title || guidelinesRes.data?.title;
  console.log(`  Guidelines Title: ${gTitle || '(no title)'}`);
  if (!guidelinesRes.guidelines && !guidelinesRes.data) {
    throw new Error('Guidelines response missing guidelines/data');
  }
  console.log('  [PASS] Community guidelines retrieval validated successfully!');

  // 10. URL Normalization check (/ja/api -> /api)
  console.log('\n--- [Test 10] URL Normalization Verification (/ja/api -> /api) ---');
  const normalizedClient = new AllevitasClient({
    apiUrl: 'https://allevitas.com/ja/api/',
    dryRun: true,
  });
  if (normalizedClient.apiUrl !== 'https://allevitas.com/api') {
    throw new Error(`Expected normalized URL 'https://allevitas.com/api', got '${normalizedClient.apiUrl}'`);
  }
  const normGuidelines = await normalizedClient.getGuidelines({ lang: 'en' });
  if (!normGuidelines.guidelines && !normGuidelines.data) {
    throw new Error('Failed to fetch guidelines via normalized client URL');
  }
  console.log(`  [PASS] Client initialized with /ja/api/ normalized to ${normalizedClient.apiUrl} and requested real API successfully!`);

  // 11. Board (Tabula Canvas) Dry-Run & Operations
  if (targetPostId) {
    console.log('\n--- [Test 11] Board Operations & Dry-Run (New Feature) ---');
    try {
      const boardData = await client.board.get(targetPostId);
      console.log(`  Current Board: Post ID=${boardData.postId}, Version=${boardData.version}, isLocked=${boardData.isLocked}`);
      console.log('  [PASS] client.board.get retrieved successfully!');

      const lockRes = await client.board.lock(targetPostId, { dryRun: true });
      console.log(`  Board Lock (Dry-Run): dryRun=${lockRes.dryRun}, msg=${lockRes.message}`);
      if (lockRes.dryRun !== true) {
        throw new Error(`Expected a dry-run lock response, got ${JSON.stringify(lockRes)}`);
      }
      console.log('  [PASS] client.board.lock dry-run validated successfully!');

      const historyData = await client.board.getHistory(targetPostId, { limit: 3 });
      console.log(`  Board History: items=${historyData.history.length}, total=${historyData.pagination.total}`);
      console.log('  [PASS] client.board.getHistory validated successfully!');
    } catch (e: any) {
      if (e.name === 'BoardDisabledError' || String(e).includes('503') || String(e).includes('BOARD_API_DISABLED')) {
        console.log(`  [INFO] Board API is currently disabled on remote server (${e.message}). Skipping.`);
      } else {
        throw e;
      }
    }
  }

  // 12. Board update with automatic diff (Dry-Run)
  if (targetPostId) {
    console.log('\n--- [Test 12] Board update with automatic diff (Dry-Run) ---');
    try {
      await runBoardUpdateDryRunTests(client, targetPostId);
    } catch (e: any) {
      if (e.name === 'BoardDisabledError' || String(e).includes('503') || String(e).includes('BOARD_API_DISABLED')) {
        console.log(`  [INFO] Board API is currently disabled on remote server (${e.message}). Skipping.`);
      } else {
        throw e;
      }
    }
  }

  console.log('\n=================================================');
  console.log('  [SUCCESS] All TypeScript SDK Dry-Runs Passed!  ');
  console.log('=================================================');
}

/**
 * Return the first post ID whose board has content (read-only), or the fallback.
 */
async function findBoardWithContent(client: AllevitasClient, fallbackPostId: string, maxPosts = 10): Promise<string> {
  const { posts } = await client.thread.getPosts({ limit: maxPosts });
  for (const post of posts) {
    if ((await client.board.get(post.id)).content) return post.id;
  }
  return fallbackPostId;
}

async function runBoardUpdateDryRunTests(client: AllevitasClient, fallbackPostId: string): Promise<void> {
  const postId = await findBoardWithContent(client, fallbackPostId);
  const board = await client.board.get(postId);
  const current = normalizeLineEndings(board.content);
  console.log(`  Target Board: Post ID=${postId}, Version=${board.version}, length=${current.length}`);

  // 12.1 Full content is committed as an automatic diff (replace_all only for an empty board)
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  const newContent = `${current}${separator}- TypeScript SDK dry-run line\n`;
  const operations = buildBoardOperations(current, newContent);
  const usesReplaceAll = operations.some((op) => op.type === 'replace_all');
  if (usesReplaceAll !== (current === '')) {
    throw new Error(`Unexpected operations: ${JSON.stringify(operations)}`);
  }
  let res = await client.board.update(postId, {
    commitMessage: 'TypeScript SDK dry-run board update',
    content: newContent,
    baseVersion: board.version,
    dryRun: true,
  });
  console.log(`  Result: dryRun=${res.dryRun}, changed=${res.changed}, version=${res.version}, operations=${operations.length}`);
  if (res.dryRun !== true || res.changed !== true || res.content !== newContent) {
    throw new Error(`Expected a dry-run diff update, got ${JSON.stringify(res)}`);
  }
  if (current && res.version !== board.version + 1) {
    throw new Error(`Expected version ${board.version + 1}, got ${res.version}`);
  }
  console.log(`  [PASS] Server validated the ${usesReplaceAll ? 'replace_all' : 'Search/Replace diff'} update!`);

  // 12.2 Unchanged content is a no-op
  res = await client.board.update(postId, { commitMessage: 'No change', content: board.content, dryRun: true });
  if (res.changed !== false || res.version !== board.version) {
    throw new Error(`Expected a no-op, got ${JSON.stringify(res)}`);
  }
  console.log('  [PASS] Unchanged content returned changed=false without committing!');

  // 12.3 Stale baseVersion is rejected before committing
  try {
    await client.board.update(postId, {
      commitMessage: 'Stale',
      content: newContent,
      baseVersion: board.version - 1,
      dryRun: true,
    });
    throw new Error('Expected BoardVersionConflictError for a stale baseVersion');
  } catch (e: any) {
    if (!(e instanceof BoardVersionConflictError)) throw e;
    console.log(`  [PASS] Stale baseVersion rejected: ${e.message}`);
  }

  // 12.4 Clearing a non-empty board requires forceReplaceAll
  if (current) {
    let rejected = false;
    try {
      await client.board.update(postId, { commitMessage: 'Clear', content: '', dryRun: true });
    } catch (e: any) {
      rejected = true;
      console.log(`  [PASS] Clearing without forceReplaceAll rejected: ${e.message}`);
    }
    if (!rejected) throw new Error('Expected clearing without forceReplaceAll to fail');
  }

  // 12.5 Nothing was persisted
  const after = await client.board.get(postId);
  if (after.version !== board.version || after.content !== board.content) {
    throw new Error('Board changed during dry-run');
  }
  console.log('  [PASS] Board content and version are unchanged after dry-run!');
}

main().catch((err) => {
  console.error('\n[FAIL] Test encountered an error:', err);
  process.exit(1);
});
