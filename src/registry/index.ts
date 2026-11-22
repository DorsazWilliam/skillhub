import type { AnyOp } from './types';
import { whoami, listApiTokens, listMcpConnections } from './account';
import { listChildren, getNode, createFolder, createDoc, createSkill, renameNode, moveNode, deleteNode, restoreNode, listTrash } from './nodes';
import { getSkill, getDraft, updateDraft, discardDraft, commitVersion, listVersions, getVersionOp, diffVersions, publishVersion, unpublish } from './docs';
import { listGrants, grantAccess, revokeAccess, setInherit, effectiveAccess } from './access';
import { uploadAsset, getAsset } from './assets';
import { findSkillsOp, search } from './search';
import { getLinks, getGraph } from './links';
import { publishSkill, getRulesSize } from './skills';
import { getWarnings, dismissWarning, restoreWarnings } from './warnings';
import { getUsage } from './usage';
import {
  listUsers,
  setUserRole,
  setUserStatus,
  listTeams,
  createTeam,
  renameTeam,
  deleteTeam,
  listTeamMembers,
  addTeamMember,
  removeTeamMember,
  listTeamAccess,
  listAudit,
  exportTree,
  getSettings,
} from './admin';

export * from './types';

/** The one operation registry. REST routes, MCP tools, OpenAPI and the SPA client are generated from this list. */
export const OPS: AnyOp[] = [
  // READ
  whoami,
  listChildren,
  getNode,
  getSkill,
  findSkillsOp,
  search,
  getAsset,
  effectiveAccess,
  listApiTokens,
  listMcpConnections,
  getLinks,
  getGraph,
  getRulesSize,
  // WRITE
  createFolder,
  createDoc,
  createSkill,
  renameNode,
  getDraft,
  updateDraft,
  discardDraft,
  commitVersion,
  listVersions,
  getVersionOp,
  diffVersions,
  uploadAsset,
  getWarnings,
  dismissWarning,
  restoreWarnings,
  // PUBLISH
  publishVersion,
  publishSkill,
  unpublish,
  // MANAGE
  listGrants,
  grantAccess,
  revokeAccess,
  setInherit,
  moveNode,
  deleteNode,
  restoreNode,
  listTrash,
  // ADMIN
  listUsers,
  setUserRole,
  setUserStatus,
  listTeams,
  createTeam,
  renameTeam,
  deleteTeam,
  listTeamMembers,
  addTeamMember,
  removeTeamMember,
  listTeamAccess,
  listAudit,
  getUsage,
  exportTree,
  getSettings,
];

export const OPS_BY_NAME: ReadonlyMap<string, AnyOp> = new Map(OPS.map((o) => [o.name, o]));
