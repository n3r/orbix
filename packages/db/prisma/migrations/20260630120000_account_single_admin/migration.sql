-- Enforce at most one admin account at the DB level, closing the setup TOCTOU race
-- (hasAnyAccount() check + insert() were not atomic). Partial unique index: at
-- most one Account row may have isAdmin = true. Non-admin rows are unconstrained.
CREATE UNIQUE INDEX "Account_single_admin" ON "Account" ("isAdmin") WHERE "isAdmin" = true;
