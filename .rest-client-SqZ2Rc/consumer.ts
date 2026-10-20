import createClient from "openapi-fetch"
import type { paths } from "./rest-openapi.generated"

const workspaceId = "00000000-0000-4000-8000-000000000001"
const resourceId = "00000000-0000-4000-8000-000000000002"
const client = createClient<paths>({ baseUrl: "https://compass.example" })

async function exerciseGeneratedClient() {
  const opportunities = await client.GET("/api/v1/workspaces/{workspaceId}/opportunities", {
    params: {
      path: { workspaceId },
      query: { cursor: "signed-cursor", limit: 25, status: "EXPLORING" },
    },
  })
  if (opportunities.data) {
    const nextCursor: string | null = opportunities.data.nextCursor
    const nullableDescription: string | null = opportunities.data.items[0]!.description
    void nextCursor
    void nullableDescription
  }
  if (opportunities.error) {
    const problemStatus: number = opportunities.error.status
    const problemCode: string = opportunities.error.code
    void problemStatus
    void problemCode
  }

  const created = await client.POST("/api/v1/workspaces/{workspaceId}/opportunities", {
    params: { path: { workspaceId } },
    body: { title: "Customers struggle to evaluate API coverage", customerSegment: null },
  })
  if (created.data) {
    const createdId: string = created.data.id
    const nullableDescription: string | null = created.data.description
    void createdId
    void nullableDescription
  }

  await client.POST("/api/v1/workspaces/{workspaceId}/solutions/{id}/roadmap-promotions", {
    params: { path: { workspaceId, id: resourceId } },
    body: { horizon: "NEXT", isPrivate: false, operationId: resourceId },
  })

  const upload = await client.POST("/api/v1/workspaces/{workspaceId}/feedback-attachment-uploads", {
    params: { path: { workspaceId } },
    body: { filename: "evidence.pdf", fileType: "application/pdf", fileSize: 1024 },
  })
  if (upload.data) {
    const clientToken: string = upload.data.clientToken
    const receipt: string = upload.data.receipt
    void clientToken
    void receipt
  }

  await client.DELETE("/api/v1/workspaces/{workspaceId}/assumptions/{id}", {
    params: { path: { workspaceId, id: resourceId } },
  })

  // @ts-expect-error request body is required by the generated 201 operation
  await client.POST("/api/v1/workspaces/{workspaceId}/opportunities", { params: { path: { workspaceId } } })

  // @ts-expect-error customerSegment only accepts a string or null
  await client.POST("/api/v1/workspaces/{workspaceId}/opportunities", { params: { path: { workspaceId } }, body: { title: "Invalid", customerSegment: 42 } })
}

void exerciseGeneratedClient
