import type { FastifyInstance } from "fastify";
import { validateProfileInput, hashPin, verifyPin, ProfileValidationError } from "@orbix/core";
import { Prisma } from "@orbix/db";
import { requireAuth } from "../lib/auth";
import { activeProfileId, requireNonKids } from "../lib/catalog-filter";
import { ensureMetadataLanguage } from "../plugins/queue";

const PROFILE_SELECT = {
  id: true,
  name: true,
  avatar: true,
  kind: true,
  maturityCap: true,
  language: true,
  isGroup: true,
  pinHash: true,
  groupMembers: {
    orderBy: { position: "asc" as const },
    select: {
      member: {
        select: {
          id: true,
          name: true,
          avatar: true,
          kind: true,
          maturityCap: true,
          isGroup: true,
        },
      },
    },
  },
} as const;

type ProfileRow = {
  id: string;
  name: string;
  avatar: string | null;
  kind: string;
  maturityCap: number | null;
  language: string;
  isGroup: boolean;
  pinHash: string | null;
  groupMembers?: {
    member: {
      id: string;
      name: string;
      avatar: string | null;
      kind: string;
      maturityCap: number | null;
      isGroup: boolean;
    };
  }[];
};

function serializeProfile(p: ProfileRow) {
  return {
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    kind: p.kind,
    maturityCap: p.maturityCap,
    language: p.language,
    isGroup: p.isGroup,
    hasPin: Boolean(p.pinHash),
    members: (p.groupMembers ?? []).map(({ member }) => ({
      id: member.id,
      name: member.name,
      avatar: member.avatar,
      kind: member.kind,
      maturityCap: member.maturityCap,
      isGroup: member.isGroup,
    })),
  };
}

function uniqueMemberIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

async function resolveGroupProfile(
  app: FastifyInstance,
  args: {
    isGroup: boolean;
    memberProfileIds: string[];
    requestedKind: "standard" | "kids";
    requestedMaturityCap: number | null;
    groupProfileId?: string;
  },
) {
  const memberProfileIds = uniqueMemberIds(args.memberProfileIds);
  if (!args.isGroup) {
    if (memberProfileIds.length > 0) throw new ProfileValidationError("personal profiles cannot have members");
    return { isGroup: false, memberProfileIds: [], kind: args.requestedKind, maturityCap: args.requestedMaturityCap };
  }

  if (memberProfileIds.length < 2) throw new ProfileValidationError("group profiles need at least two members");
  if (args.groupProfileId && memberProfileIds.includes(args.groupProfileId)) {
    throw new ProfileValidationError("group profiles cannot include themselves");
  }

  const members = await app.prisma.profile.findMany({
    where: { id: { in: memberProfileIds } },
    select: { id: true, kind: true, maturityCap: true, isGroup: true },
  });
  if (members.length !== memberProfileIds.length) throw new ProfileValidationError("group member missing");
  if (members.some((member) => member.isGroup)) throw new ProfileValidationError("nested group profiles are not supported");

  const byId = new Map(members.map((member) => [member.id, member]));
  const orderedMembers = memberProfileIds.map((id) => byId.get(id)!);
  const kidsMembers = orderedMembers.filter((member) => member.kind === "kids");

  if (kidsMembers.length === 0) {
    return {
      isGroup: true,
      memberProfileIds,
      kind: args.requestedKind,
      maturityCap: args.requestedMaturityCap,
    };
  }

  const memberCap = Math.min(...kidsMembers.map((member) => member.maturityCap ?? 0));
  const requestedCap = args.requestedKind === "kids" ? (args.requestedMaturityCap ?? 0) : memberCap;
  return {
    isGroup: true,
    memberProfileIds,
    kind: "kids" as const,
    maturityCap: Math.min(memberCap, requestedCap),
  };
}

export default async function profiles(app: FastifyInstance) {
  // GET /me/profile — returns the active profile (for UI gating + the client route guard)
  app.get("/me/profile", { preHandler: requireAuth(app) }, async (req, reply) => {
    const profileId = await activeProfileId(app, req);
    if (!profileId) {
      return reply.send({
        id: null,
        name: null,
        avatar: null,
        kind: null,
        maturityCap: null,
        language: null,
        isGroup: false,
        hasPin: false,
        members: [],
      });
    }
    const profile = await app.prisma.profile.findUnique({ where: { id: profileId }, select: PROFILE_SELECT });
    if (!profile) {
      return reply.send({
        id: null,
        name: null,
        avatar: null,
        kind: null,
        maturityCap: null,
        language: null,
        isGroup: false,
        hasPin: false,
        members: [],
      });
    }
    return reply.send(serializeProfile(profile));
  });

  // GET /profiles — select pinHash only to derive hasPin; never serialize it.
  app.get("/profiles", { preHandler: requireAuth(app) }, async () =>
    (await app.prisma.profile.findMany({
      select: PROFILE_SELECT,
      orderBy: { createdAt: "asc" },
    })).map(serializeProfile));

  app.post<{ Body: unknown }>("/profiles", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
    try {
      const v = validateProfileInput(req.body);
      const group = await resolveGroupProfile(app, {
        isGroup: v.isGroup,
        memberProfileIds: v.memberProfileIds ?? [],
        requestedKind: v.kind,
        requestedMaturityCap: v.maturityCap ?? null,
      });
      const pinHash = v.pin ? await hashPin(v.pin) : null;
      const p = await app.prisma.$transaction(async (tx) => {
        const created = await tx.profile.create({
          data: {
            name: v.name,
            kind: group.kind,
            maturityCap: group.maturityCap,
            language: v.language,
            pinHash,
            isGroup: group.isGroup,
          },
          select: { id: true },
        });
        if (group.memberProfileIds.length > 0) {
          await tx.profileGroupMember.createMany({
            data: group.memberProfileIds.map((memberProfileId, position) => ({
              groupProfileId: created.id,
              memberProfileId,
              position,
            })),
          });
        }
        return tx.profile.findUnique({ where: { id: created.id }, select: PROFILE_SELECT });
      });
      // A new profile may introduce a not-yet-cached content language.
      await ensureMetadataLanguage(app, v.language);
      return serializeProfile(p!);
    } catch (e) {
      if (e instanceof ProfileValidationError) return reply.code(400).send({ error: "invalid_profile" });
      throw e;
    }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/profiles/:id", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
    try {
      const existing = await app.prisma.profile.findUnique({ where: { id: req.params.id }, select: PROFILE_SELECT });
      if (!existing) return reply.code(404).send({ error: "not_found" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const nextIsGroup = body.isGroup ?? existing.isGroup;
      const existingMemberIds = (existing.groupMembers ?? []).map(({ member }) => member.id);
      const merged = validateProfileInput({
        name: body.name ?? existing.name,
        kind: body.kind ?? existing.kind,
        maturityCap: body.maturityCap ?? existing.maturityCap ?? undefined,
        language: body.language ?? existing.language,
        isGroup: nextIsGroup,
        memberProfileIds: body.memberProfileIds ?? (nextIsGroup ? existingMemberIds : undefined),
        ...(body.pin !== undefined && body.pin !== "" ? { pin: body.pin } : {}),
      });
      const group = await resolveGroupProfile(app, {
        isGroup: merged.isGroup,
        memberProfileIds: merged.memberProfileIds ?? [],
        requestedKind: merged.kind,
        requestedMaturityCap: merged.maturityCap ?? null,
        groupProfileId: req.params.id,
      });
      const pinHash = body.pin !== undefined
        ? (body.pin ? await hashPin(String(body.pin)) : null)
        : undefined;
      const data: Record<string, unknown> = {
        name: merged.name,
        kind: group.kind,
        maturityCap: group.maturityCap,
        language: merged.language,
        isGroup: group.isGroup,
      };
      if (pinHash !== undefined) data.pinHash = pinHash;
      const p = await app.prisma.$transaction(async (tx) => {
        await tx.profile.update({
          where: { id: req.params.id },
          data,
          select: { id: true },
        });
        await tx.profileGroupMember.deleteMany({ where: { groupProfileId: req.params.id } });
        if (group.memberProfileIds.length > 0) {
          await tx.profileGroupMember.createMany({
            data: group.memberProfileIds.map((memberProfileId, position) => ({
              groupProfileId: req.params.id,
              memberProfileId,
              position,
            })),
          });
        }
        return tx.profile.findUnique({ where: { id: req.params.id }, select: PROFILE_SELECT });
      });
      // Switching a profile to a new language may require caching its metadata.
      if (merged.language !== existing.language) {
        await ensureMetadataLanguage(app, merged.language);
      }
      return serializeProfile(p!);
    } catch (e) {
      if (e instanceof ProfileValidationError) return reply.code(400).send({ error: "invalid_profile" });
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return reply.code(404).send({ error: "not_found" });
      throw e;
    }
  });

  app.post<{ Params: { id: string }; Body: { pin?: string } }>("/profiles/:id/select", { preHandler: requireAuth(app) }, async (req, reply) => {
    const p = await app.prisma.profile.findUnique({ where: { id: req.params.id } });
    if (!p) return reply.code(404).send({ error: "not_found" });
    if (p.pinHash) {
      if (!req.body?.pin || !(await verifyPin(p.pinHash, req.body.pin))) {
        return reply.code(403).send({ error: "pin_required" });
      }
    }
    if (req.deviceId) {
      // Device clients have no cookie jar: the active profile lives on the row.
      await app.prisma.deviceToken.update({
        where: { id: req.deviceId },
        data: { activeProfileId: p.id },
      });
      return { profileId: p.id };
    }
    reply.setCookie("orbix_profile", p.id, { httpOnly: true, sameSite: "lax", path: "/" });
    return { profileId: p.id };
  });

  app.delete<{ Params: { id: string } }>("/profiles/:id", { preHandler: [requireAuth(app), requireNonKids(app)] }, async (req, reply) => {
    try {
      await app.prisma.profile.delete({ where: { id: req.params.id } });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return reply.code(404).send({ error: "not_found" });
      throw e;
    }
  });
}
