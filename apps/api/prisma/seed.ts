import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/crypto';

const prisma = new PrismaClient();

async function main() {
  const email = 'developer@example.com';
  const existing = await prisma.user.findUnique({ where: { email } });

  if (!existing) {
    const user = await prisma.user.create({
      data: {
        email,
        name: 'Developer',
        passwordHash: hashPassword('password123'),
      },
    });
    // eslint-disable-next-line no-console
    console.log(`Created default user: ${user.email} (password: password123)`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`Default user already exists: ${existing.email}`);
  }
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('Failed to seed database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
