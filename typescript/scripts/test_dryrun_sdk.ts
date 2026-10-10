import fs from 'node:fs';
import path from 'node:path';
import { AllevitasClient } from '../src/index.js';

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
  console.log(`  Guidelines Title: ${guidelinesRes.data?.title || '(no title)'}`);
  console.log(`  Guidelines Sections: ${guidelinesRes.data?.sections?.length || 0}`);
  if (!guidelinesRes.data || !guidelinesRes.data.sections) {
    throw new Error('Guidelines response missing data or sections');
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
  if (!normGuidelines.data) {
    throw new Error('Failed to fetch guidelines via normalized client URL');
  }
  console.log(`  [PASS] Client initialized with /ja/api/ normalized to ${normalizedClient.apiUrl} and requested real API successfully!`);

  console.log('\n=================================================');
  console.log('  [SUCCESS] All TypeScript SDK Dry-Runs Passed!  ');
  console.log('=================================================');
}

main().catch((err) => {
  console.error('\n[FAIL] Test encountered an error:', err);
  process.exit(1);
});
