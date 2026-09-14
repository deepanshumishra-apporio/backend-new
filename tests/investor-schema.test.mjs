import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const migrations = new URL('../prisma/migrations/', import.meta.url);
before(async () => {
  const entries = await readdir(migrations, { withFileTypes: true });
  for (const entry of entries.filter(x => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    await db.exec(await readFile(new URL(`${entry.name}/migration.sql`, migrations), 'utf8'));
  }
});
after(async () => { await db.close(); });

async function request(fpId = `pv_${randomUUID()}`) {
  const id = randomUUID();
  await db.query(`INSERT INTO pre_verifications (id, "fpId", status, "updatedAt")
    VALUES ($1, $2, 'accepted', now())`, [id, fpId]);
  return id;
}
async function bank(parent, position = 0) {
  return db.query(`INSERT INTO pre_verification_bank_results
    (id, "preVerificationId", position, "accountNumber", "ifscCode", "accountType", "updatedAt")
    VALUES ($1, $2, $3, '00001234', 'TEST0001234', 'savings', now())`,
  [randomUUID(), parent, position]);
}

test('verification may precede profile creation and pending verdicts remain null', async () => {
  const id = await request();
  const { rows: [row] } = await db.query('SELECT * FROM pre_verifications WHERE id = $1', [id]);
  assert.equal(row.userId, null);
  assert.equal(row.investorProfileId, null);
  assert.equal(row.readinessStatus, null);
  assert.equal(row.panStatus, null);
});
test('provider id prevents duplicate projections; new attempts remain distinct', async () => {
  const fpId = `pv_${randomUUID()}`;
  await request(fpId);
  await assert.rejects(request(fpId), { code: '23505' });
  await request();
});
test('all bank results can be stored with independent verdicts and explicit consent', async () => {
  const id = await request();
  await bank(id, 0);
  await bank(id, 1);
  await db.query(`UPDATE pre_verification_bank_results SET status = 'failed', code = 'low_confidence'
    WHERE "preVerificationId" = $1 AND position = 1`, [id]);
  await db.query(`UPDATE pre_verifications SET status = 'completed', "readinessStatus" = 'verified'
    WHERE id = $1`, [id]);
  const { rows } = await db.query(`SELECT * FROM pre_verification_bank_results
    WHERE "preVerificationId" = $1 ORDER BY position`, [id]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].accountNumber, '00001234');
  assert.equal(rows[0].manualVerificationApproved, null);
  assert.equal(rows[1].status, 'failed');
  await assert.rejects(bank(id, 1), { code: '23505' });
  await assert.rejects(bank(id, -1), { code: '23514' });
});
test('foreign keys reject orphan bank results and remove children with their request', async () => {
  await assert.rejects(bank(randomUUID()), { code: '23503' });
  const id = await request();
  await bank(id);
  await db.query('DELETE FROM pre_verifications WHERE id = $1', [id]);
  const { rows } = await db.query('SELECT id FROM pre_verification_bank_results WHERE "preVerificationId" = $1', [id]);
  assert.equal(rows.length, 0);
});
test('deleting an app user retains provider verification evidence', async () => {
  const user = randomUUID();
  await db.query(`INSERT INTO users (id, phone, "updatedAt") VALUES ($1, '+919876543210', now())`, [user]);
  const id = await request();
  await db.query('UPDATE pre_verifications SET "userId" = $1 WHERE id = $2', [user, id]);
  await db.query('DELETE FROM users WHERE id = $1', [user]);
  const { rows } = await db.query('SELECT "userId" FROM pre_verifications WHERE id = $1', [id]);
  assert.deepEqual(rows, [{ userId: null }]);
});
