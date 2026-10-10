import { readSlip } from './extract.mjs';

const args = process.argv.slice(2);
const imagePath = args[0];
const amountFlag = args.indexOf('--expected-amount');
if (!imagePath || args.includes('--help') || (amountFlag >= 0 && !args[amountFlag + 1])) {
  console.error('Usage: npm run read -- <slip-image> [--expected-amount 123.45]');
  process.exitCode = 2;
} else {
  const expectedAmount = amountFlag >= 0 ? Number(args[amountFlag + 1]) : null;
  if (expectedAmount !== null && (!Number.isFinite(expectedAmount) || expectedAmount < 0)) {
    console.error('Expected amount must be a non-negative number.');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await readSlip(imagePath, { expectedAmount }), null, 2));
    } catch (error) {
      console.error(`Unable to read slip: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
