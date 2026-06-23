// Usage: node scripts/add-agent.js <email> <password> [name]
// Add a new agent, or update / re-enable an existing one (idempotent upsert).
const { makePrisma } = require('./prisma-client');
const bcrypt = require('bcryptjs');

async function main() {
  const [, , emailArg, password, ...nameParts] = process.argv;
  if (!emailArg || !password) {
    console.error('Usage: node scripts/add-agent.js <email> <password> [name]');
    process.exit(1);
  }
  const email = emailArg.trim().toLowerCase();
  const name = nameParts.join(' ') || null;
  const passwordHash = await bcrypt.hash(password, 10);
  const prisma = makePrisma();
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, active: true, ...(name ? { name } : {}) },
    create: { email, passwordHash, name, role: 'agent' },
  });
  console.log(`Saved agent ${user.email} (active=${user.active})`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
