export default async function globalSetup() {
  // Set DATABASE_URL before importing @orbix/db so PrismaClient picks it up
  process.env.DATABASE_URL ??=
    "postgresql://orbix:orbix@localhost:1062/orbix";

  // Dynamic import ensures env var is set before PrismaClient singleton is created
  const { prisma } = await import("@orbix/db");
  try {
    await prisma.profile.deleteMany();
    await prisma.account.deleteMany();
    console.log("[global-setup] DB cleared successfully.");
  } finally {
    await prisma.$disconnect();
  }
}
