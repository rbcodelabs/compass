import { withCardSortContext } from "@/lib/card-sort-route"
import {
  createCardSortRound,
  isCardSortRoundState,
  listCardSortRounds,
  CardSortError,
} from "@/lib/card-sort"

export async function GET(request: Request) {
  return withCardSortContext(request, async ({ userId, workspaceId }) => {
    const stateParam = new URL(request.url).searchParams.get("state")
    if (stateParam && !isCardSortRoundState(stateParam)) {
      throw new CardSortError("INVALID_VALUE", `Unknown round state: ${stateParam}`)
    }
    const rounds = await listCardSortRounds({
      workspaceId,
      userId,
      state: stateParam && isCardSortRoundState(stateParam) ? stateParam : undefined,
    })
    return { rounds }
  })
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    name?: unknown
    fieldDefinitionId?: unknown
  } | null

  return withCardSortContext(request, async ({ userId, workspaceId }) => {
    if (typeof body?.name !== "string" || typeof body?.fieldDefinitionId !== "string") {
      throw new CardSortError("INVALID_VALUE", "name and fieldDefinitionId are required")
    }
    const round = await createCardSortRound({
      workspaceId,
      userId,
      name: body.name,
      fieldDefinitionId: body.fieldDefinitionId,
    })
    return { round }
  })
}
