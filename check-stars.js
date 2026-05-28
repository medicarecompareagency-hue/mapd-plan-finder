const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
p.plan.count({where:{planYear:2026, starRating:{not:null}}})
  .then(n => { console.log('Plans with starRating:', n); return p.$disconnect(); });
