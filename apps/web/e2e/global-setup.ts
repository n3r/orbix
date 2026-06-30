export default async function globalSetup() {
  // This wipe is DESTRUCTIVE (deletes every account + profile). It must only
  // run against a throwaway DB. Refuse unless explicitly opted in, so running
  // the e2e suite never silently nukes a populated dev database.
  if (process.env.E2E_ALLOW_DB_RESET !== "1" && !process.env.CI) {
    throw new Error(
      "[global-setup] Refusing to wipe the database: this deletes ALL accounts " +
        "and profiles. Set E2E_ALLOW_DB_RESET=1 (and point DATABASE_URL at a " +
        "throwaway DB) to run the e2e suite.",
    );
  }

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
