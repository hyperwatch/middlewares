// Checks the published type declarations the way a TypeScript user gets
// them: packs the package (prepack generates types/), installs the tarball in
// a temporary project with its dependencies only (and @types/express, to use
// the middlewares with Express), then type-checks
// test/types/consumer.ts and every published declaration file, strict and
// without skipLibCheck.
//
//   npm run types:test
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 */
function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
      .toString()
      .trim();
  } catch (error) {
    const err =
      /** @type {import('node:child_process').SpawnSyncReturns<Buffer>} */ (
        error
      );
    // What the command printed (tsc reports errors on stdout), then which
    // step failed
    if (err.stdout && err.stdout.length) {
      process.stderr.write(err.stdout);
    }
    console.error(`\`${command} ${args.join(' ')}\` failed`);
    throw err;
  }
}

// The versions the package is developed with
/** @param {string} name */
function version(name) {
  return JSON.parse(
    fs.readFileSync(
      path.join(root, 'node_modules', name, 'package.json'),
      'utf8'
    )
  ).version;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'middlewares-types-'));
  try {
    const tarball = run(
      'npm',
      ['pack', '--silent', '--pack-destination', tmp],
      root
    )
      .split('\n')
      .pop();
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      `${JSON.stringify({ name: 'consumer', private: true }, null, 2)}\n`
    );
    run(
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        `./${tarball}`,
        `typescript@${version('typescript')}`,
        `@types/node@${version('@types/node')}`,
        // TypeScript users of Express have it
        `@types/express@${version('@types/express')}`,
      ],
      tmp
    );
    fs.copyFileSync(
      path.join(root, 'test', 'types', 'consumer.ts'),
      path.join(tmp, 'consumer.ts')
    );
    fs.writeFileSync(
      path.join(tmp, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            noEmit: true,
            strict: true,
            module: 'nodenext',
            moduleResolution: 'nodenext',
            target: 'es2023',
            lib: ['es2023'],
            types: ['node'],
            skipLibCheck: false,
          },
          include: [
            'consumer.ts',
            'node_modules/@hyperwatch/middlewares/types/**/*.d.ts',
          ],
        },
        null,
        2
      )}\n`
    );
    run(
      path.join(tmp, 'node_modules', '.bin', 'tsc'),
      ['-p', '.', '--pretty', 'false'],
      tmp
    );
    console.log('The published declarations type-check.');
  } catch (err) {
    process.exitCode = 1;
    if (/** @type {{ status?: number }} */ (err).status === undefined) {
      console.error(err);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
