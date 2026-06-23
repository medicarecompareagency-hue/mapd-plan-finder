// Usage: node scripts/disable-agent.js <email>
const { makePrisma } = require('./prisma-client');

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('Usage: node scripts/disable-agent.js <email>');
    process.exit(1);
  }
  const prisma = makePrisma();
  const u = await prisma.user.update({ where: { email }, data: { active: false } });
  console.log(`Disabled ${u.email}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
