import { db } from '@sim/db'
import { member, organization, permissions, workflow, workspace } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { and, eq, isNull } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { AuditAction, AuditResourceType, recordAudit } from '@/lib/audit/log'
import { getSession } from '@/lib/auth'
import { generateId } from '@/lib/core/utils/uuid'
import { captureServerEvent } from '@/lib/posthog/server'
import { buildDefaultWorkflowArtifacts } from '@/lib/workflows/defaults'
import { saveWorkflowToNormalizedTables } from '@/lib/workflows/persistence/utils'
import { getRandomWorkspaceColor } from '@/lib/workspaces/colors'

const logger = createLogger('OrganizationWorkspacesAPI')

const createOrgWorkspaceSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  skipDefaultWorkflow: z.boolean().optional().default(false),
})

/**
 * GET /api/organizations/[id]/workspaces
 *
 * Returns all workspaces owned by the specified organization.
 * Caller must be a member of the organization.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession()

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: organizationId } = await params

    // Verify user is a member of the organization
    const memberEntry = await db
      .select({ id: member.id, role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)))
      .limit(1)
      .then((rows) => rows[0])

    if (!memberEntry) {
      return NextResponse.json(
        { error: 'Forbidden - Not a member of this organization' },
        { status: 403 }
      )
    }

    const orgWorkspaces = await db
      .select({
        id: workspace.id,
        name: workspace.name,
        color: workspace.color,
        ownerId: workspace.ownerId,
        organizationId: workspace.organizationId,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })
      .from(workspace)
      .where(and(eq(workspace.organizationId, organizationId), isNull(workspace.archivedAt)))

    return NextResponse.json({ workspaces: orgWorkspaces })
  } catch (error) {
    logger.error('Error fetching organization workspaces:', error)
    return NextResponse.json({ error: 'Failed to fetch organization workspaces' }, { status: 500 })
  }
}

/**
 * POST /api/organizations/[id]/workspaces
 *
 * Creates a new workspace owned by the specified organization.
 * All current organization members are granted read access automatically.
 * Caller must be an org admin or owner.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession()

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: organizationId } = await params

    // Verify the organization exists
    const org = await db
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1)
      .then((rows) => rows[0])

    if (!org) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
    }

    // Verify caller is an admin or owner of the organization
    const memberEntry = await db
      .select({ id: member.id, role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)))
      .limit(1)
      .then((rows) => rows[0])

    if (!memberEntry) {
      return NextResponse.json(
        { error: 'Forbidden - Not a member of this organization' },
        { status: 403 }
      )
    }

    const userRole = memberEntry.role
    if (!['owner', 'admin'].includes(userRole)) {
      return NextResponse.json(
        { error: 'Forbidden - Admin access required to create organization workspaces' },
        { status: 403 }
      )
    }

    const { name, color, skipDefaultWorkflow } = createOrgWorkspaceSchema.parse(
      await request.json()
    )

    const workspaceId = generateId()
    const workflowId = generateId()
    const now = new Date()
    const workspaceColor = color || getRandomWorkspaceColor()

    // Fetch all current org members to grant them access
    const orgMembers = await db
      .select({ userId: member.userId, role: member.role })
      .from(member)
      .where(eq(member.organizationId, organizationId))

    await db.transaction(async (tx) => {
      // Create the workspace linked to the organization
      await tx.insert(workspace).values({
        id: workspaceId,
        name,
        color: workspaceColor,
        ownerId: session.user.id,
        billedAccountUserId: session.user.id,
        organizationId,
        allowPersonalApiKeys: true,
        createdAt: now,
        updatedAt: now,
      })

      // Grant access to all current org members
      const permissionInserts = orgMembers.map((m) => ({
        id: generateId(),
        entityType: 'workspace' as const,
        entityId: workspaceId,
        userId: m.userId,
        // Org admins/owners get admin access; regular members get read access
        permissionType: (['owner', 'admin'].includes(m.role) ? 'admin' : 'read') as
          'admin' | 'read',
        createdAt: now,
        updatedAt: now,
      }))

      if (permissionInserts.length > 0) {
        await tx.insert(permissions).values(permissionInserts)
      }

      if (!skipDefaultWorkflow) {
        await tx.insert(workflow).values({
          id: workflowId,
          userId: session.user.id,
          workspaceId,
          folderId: null,
          name: 'default-agent',
          description: 'Your first workflow - start building here!',
          color: '#3972F6',
          lastSynced: now,
          createdAt: now,
          updatedAt: now,
          isDeployed: false,
          runCount: 0,
          variables: {},
        })

        const { workflowState } = buildDefaultWorkflowArtifacts()
        await saveWorkflowToNormalizedTables(workflowId, workflowState, tx)
      }
    })

    captureServerEvent(
      session.user.id,
      'org_workspace_created',
      { workspace_id: workspaceId, organization_id: organizationId, name },
      { groups: { workspace: workspaceId, organization: organizationId } }
    )

    recordAudit({
      workspaceId,
      actorId: session.user.id,
      actorName: session.user.name,
      actorEmail: session.user.email,
      action: AuditAction.WORKSPACE_CREATED,
      resourceType: AuditResourceType.WORKSPACE,
      resourceId: workspaceId,
      resourceName: name,
      description: `Created organization workspace "${name}" for org "${org.name}"`,
      metadata: { name, organizationId },
      request,
    })

    logger.info(`Created org workspace ${workspaceId} for org ${organizationId}`)

    return NextResponse.json({
      workspace: {
        id: workspaceId,
        name,
        color: workspaceColor,
        ownerId: session.user.id,
        organizationId,
        createdAt: now,
        updatedAt: now,
      },
    })
  } catch (error) {
    logger.error('Error creating organization workspace:', error)
    return NextResponse.json({ error: 'Failed to create organization workspace' }, { status: 500 })
  }
}
