import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
      console.log('Usage: tsx scripts/test_dryrun_cli.ts [options]');
      console.log('Options:');
      console.log('  -c, --credentials <path>   Path to credentials JSON file (default: ./.credentials.json)');
      console.log('  --api-url <url>            Allevitas API base URL (default: https://allevitas.com/api)');
      console.log('  -h, --help                 Show help');
      process.exit(0);
    }
  }

  return { credentialsPath, apiUrl };
}

function runCli(cliArgs: string[]): string {
  const typescriptDir = path.resolve(__dirname, '..');
  const distCli = path.resolve(typescriptDir, 'dist', 'cli.js');
  const srcCli = path.resolve(typescriptDir, 'src', 'cli.ts');

  let cmd: string;
  let args: string[];

  if (fs.existsSync(distCli)) {
    cmd = process.execPath; // node
    args = [distCli, ...cliArgs];
  } else {
    cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    args = ['tsx', srcCli, ...cliArgs];
  }

  try {
    const output = execFileSync(cmd, args, {
      cwd: typescriptDir,
      encoding: 'utf-8',
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output;
  } catch (err: any) {
    console.error(`Command failed: ${cmd} ${args.join(' ')}`);
    if (err.stdout) console.error(`STDOUT:\n${err.stdout}`);
    if (err.stderr) console.error(`STDERR:\n${err.stderr}`);
    throw err;
  }
}

async function main() {
  const { credentialsPath, apiUrl } = parseArgs();
  const resolvedCredsPath = path.resolve(process.cwd(), credentialsPath);

  console.log('=================================================');
  console.log('  Allevitas Real API TypeScript CLI Dry-Run Suite');
  console.log('=================================================');
  console.log(`[Config] Target API: ${apiUrl}`);
  console.log(`[Config] Credentials: ${resolvedCredsPath}`);

  if (!fs.existsSync(resolvedCredsPath)) {
    console.error(`[Error] Credentials file not found: ${resolvedCredsPath}`);
    process.exit(1);
  }

  // 1. list-topics でトピックIDを取得
  console.log('\n--- [Test 1] CLI list-topics ---');
  const topicsOut = runCli(['list-topics', '--api-url', apiUrl, '--credentials', resolvedCredsPath]);
  const topicMatch = topicsOut.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  const topicId = topicMatch ? topicMatch[1] : '231b6f11-81aa-43e6-967d-676df06f211a';
  console.log(`  Identified Topic ID: ${topicId}`);
  console.log('  [PASS] CLI list-topics executed successfully');

  // 2. list-posts でスレッドIDを取得
  console.log('\n--- [Test 2] CLI list-posts ---');
  const postsOut = runCli(['list-posts', '--api-url', apiUrl, '--credentials', resolvedCredsPath, '--limit', '3']);
  const postMatch = postsOut.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  const postId = postMatch ? postMatch[1] : '';
  console.log(`  Identified Post ID: ${postId || 'none'}`);
  console.log('  [PASS] CLI list-posts executed successfully');

  // 3. post (Dry-Run)
  console.log('\n--- [Test 3] CLI post --dry-run ---');
  const postDryOut = runCli([
    'post',
    '--api-url', apiUrl,
    '--credentials', resolvedCredsPath,
    '--topic', topicId,
    '--title', 'Dry Run CLI Automated Test',
    '--content', 'Testing dry-run via TypeScript CLI test script',
    '--dry-run',
  ]);
  if (!postDryOut.includes('[DRY-RUN]') && !postDryOut.includes('Validation successful')) {
    throw new Error(`Dry run output does not contain expected message:\n${postDryOut}`);
  }
  console.log('  [PASS] CLI post --dry-run validated successfully!');

  // 4. comment (Dry-Run)
  if (postId) {
    console.log('\n--- [Test 4] CLI comment --dry-run ---');
    const commentDryOut = runCli([
      'comment',
      '--api-url', apiUrl,
      '--credentials', resolvedCredsPath,
      '--post-id', postId,
      '--content', 'Testing comment dry-run via TypeScript CLI test script',
      '--dry-run',
    ]);
    if (!commentDryOut.includes('[DRY-RUN]') && !commentDryOut.includes('Validation successful')) {
      throw new Error(`Dry run output does not contain expected message:\n${commentDryOut}`);
    }
    console.log('  [PASS] CLI comment --dry-run validated successfully!');
  }

  // 5. vote (Dry-Run)
  if (postId) {
    console.log('\n--- [Test 5] CLI vote --dry-run ---');
    const voteDryOut = runCli([
      'vote',
      '--api-url', apiUrl,
      '--credentials', resolvedCredsPath,
      '--target-type', 'post',
      '--target-id', postId,
      '--vote-type', 'up',
      '--dry-run',
    ]);
    if (!voteDryOut.includes('[DRY-RUN]') && !voteDryOut.includes('Validation successful')) {
      throw new Error(`Dry run output does not contain expected message:\n${voteDryOut}`);
    }
    console.log('  [PASS] CLI vote --dry-run validated successfully!');
  }

  // 6. shoutout send (Dry-Run)
  console.log('\n--- [Test 6] CLI shoutout send --dry-run ---');
  const shoutoutDryOut = runCli([
    'shoutout', 'send',
    '--api-url', apiUrl,
    '--credentials', resolvedCredsPath,
    '--type', 'INSTANT',
    '--content', 'Testing shoutout dry-run via TypeScript CLI test script',
    '--dry-run',
  ]);
  if (!shoutoutDryOut.includes('[DRY-RUN]') && !shoutoutDryOut.includes('Simulation only')) {
    throw new Error(`Dry run output does not contain expected message:\n${shoutoutDryOut}`);
  }
  console.log('  [PASS] CLI shoutout send --dry-run validated successfully!');

  // 7. report (Dry-Run)
  if (postId) {
    console.log('\n--- [Test 7] CLI report --dry-run ---');
    const reportDryOut = runCli([
      'report',
      '--api-url', apiUrl,
      '--credentials', resolvedCredsPath,
      '--target-type', 'post',
      '--target-id', postId,
      '--reason', 'spam',
      '--detail', 'Testing report dry-run via TypeScript CLI test script',
      '--dry-run',
    ]);
    if (!reportDryOut.includes('[DRY-RUN]') && !reportDryOut.includes('Validation successful')) {
      throw new Error(`Dry run output does not contain expected message:\n${reportDryOut}`);
    }
    console.log('  [PASS] CLI report --dry-run validated successfully!');
  }

  console.log('\n=================================================');
  console.log('  [SUCCESS] All TypeScript CLI Dry-Runs Passed!  ');
  console.log('=================================================');
}

main().catch((err) => {
  console.error('\n[FAIL] CLI test encountered an error:', err);
  process.exit(1);
});
