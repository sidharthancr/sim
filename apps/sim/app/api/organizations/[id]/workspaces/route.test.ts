/**
 * @vitest-environment node
 */
import { createMockRequest } from '@sim/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetSession, mockDbResults, mockDbChain, mockInsertValues, mockRandomUUID } = vi.hoisted(
  () => {
    const mockGetSession = vi.fn()
    const mockInsertValues = vi.fn().mockResolvedValue(undefined)
    const mockRandomUUID = vi.fn().mockReturnValue('mock-uuid-1234')

    const mockDbResults: { value: unknown[] } = { value: [] }

    const mockDbChain: Record<string, unknown> = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: mockInsertValues,
      transaction: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback(mockDbChain)
      ),
      then: vi.fn().mockImplementation((callback: (result: unknown[]) => unknown) => {
        const result = mockDbResults.value.shift() || []
        return callback ? callback(result) : Promise.resolve(result)
      }),
    }

    return { mockGetSession, mockDbResults, mockDbChain, mockInsertValues, mockRandomUUID }
  }
)

vi.mock('@/lib/core/utils/uuid', () => ({
  generateId: mockRandomUUID,
  generateShortId: vi.fn(() => 'mock-short-id'),
}))

vi.mock('@/lib/auth', () => ({
  getSession: mockGetSession,
}))

vi.mock('@sim/db', () => ({
  db: mockDbChain,
}))

vi.mock('@sim/db/schema', () => ({
  member: { id: 'member_id', userId: 'user_id', organizationId: 'org_id', role: 'role' },
  organization: { id: 'org_id', name: 'org_name' },
  permissions: {
    id: 'perm_id',
    entityType: 'entity_type',
    entityId: 'entity_id',
    userId: 'user_id',
    permissionType: 'permission_type',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  workspace: {
    id: 'workspace_id',
    name: 'workspace_name',
    color: 'color',
    ownerId: 'owner_id',
    organizationId: 'organization_id',
    archivedAt: 'archived_at',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  workflow: {
    id: 'workflow_id',
    userId: 'user_id',
    workspaceId: 'workspace_id',
    name: 'name',
    description: 'description',
    color: 'color',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
}))

vi.mock('@/lib/audit/log', () => ({
  recordAudit: vi.fn(),
  AuditAction: { WORKSPACE_CREATED: 'workspace.created' },
  AuditResourceType: { WORKSPACE: 'workspace' },
}))

vi.mock('@/lib/posthog/server', () => ({
  captureServerEvent: vi.fn(),
}))

vi.mock('@/lib/workflows/defaults', () => ({
  buildDefaultWorkflowArtifacts: vi.fn().mockReturnValue({
    workflowState: { blocks: {}, edges: [], variables: {} },
  }),
}))

vi.mock('@/lib/workflows/persistence/utils', () => ({
  saveWorkflowToNormalizedTables: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/workspaces/colors', () => ({
  getRandomWorkspaceColor: vi.fn().mockReturnValue('#33C482'),
}))

import { GET, POST } from '@/app/api/organizations/[id]/workspaces/route'

const ORG_ID = 'org-123'

describe('GET /api/organizations/[id]/workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValue(null)

    const request = createMockRequest('GET')
    const response = await GET(request, { params: Promise.resolve({ id: ORG_ID }) })
    const data = await response.json()

    expect(response.status).toBe(401)
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 403 when user is not an org member', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } })
    // Member lookup returns empty
    mockDbResults.value = [[]]

    const request = createMockRequest('GET')
    const response = await GET(request, { params: Promise.resolve({ id: ORG_ID }) })
    const data = await response.json()

    expect(response.status).toBe(403)
    expect(data.error).toContain('Not a member')
  })

  it('returns org workspaces for an org member', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } })

    const mockMember = [{ id: 'member-1', role: 'member' }]
    const mockWorkspaces = [
      {
        id: 'ws-1',
        name: 'Team Workspace',
        color: '#3972F6',
        ownerId: 'user-1',
        organizationId: ORG_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]

    mockDbResults.value = [mockMember, mockWorkspaces]

    const request = createMockRequest('GET')
    const response = await GET(request, { params: Promise.resolve({ id: ORG_ID }) })
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.workspaces).toBeDefined()
  })
})

describe('POST /api/organizations/[id]/workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when not authenticated', async () => {
    mockGetSession.mockResolvedValue(null)

    const request = createMockRequest('POST', { name: 'Test Workspace' })
    const response = await POST(request, { params: Promise.resolve({ id: ORG_ID }) })
    const data = await response.json()

    expect(response.status).toBe(401)
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 404 when organization does not exist', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } })
    // Org lookup returns empty
    mockDbResults.value = [[]]

    const request = createMockRequest('POST', { name: 'Test Workspace' })
    const response = await POST(request, { params: Promise.resolve({ id: ORG_ID }) })
    const data = await response.json()

    expect(response.status).toBe(404)
    expect(data.error).toBe('Organization not found')
  })

  it('returns 403 when user is not an org member', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } })
    // Org found, member lookup returns empty
    mockDbResults.value = [[{ id: ORG_ID, name: 'Test Org' }], []]

    const request = createMockRequest('POST', { name: 'Test Workspace' })
    const response = await POST(request, { params: Promise.resolve({ id: ORG_ID }) })
    const data = await response.json()

    expect(response.status).toBe(403)
    expect(data.error).toContain('Not a member')
  })

  it('returns 403 when user is not an org admin', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } })
    // Org found, member found as regular member (not admin)
    mockDbResults.value = [[{ id: ORG_ID, name: 'Test Org' }], [{ id: 'member-1', role: 'member' }]]

    const request = createMockRequest('POST', { name: 'Test Workspace' })
    const response = await POST(request, { params: Promise.resolve({ id: ORG_ID }) })
    const data = await response.json()

    expect(response.status).toBe(403)
    expect(data.error).toContain('Admin access required')
  })
})
