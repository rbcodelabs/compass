import { withCardSortContext } from "@/lib/card-sort-route"
import { CardSortError, isCardSortObjectType, listCardSortFactors } from "@/lib/card-sort"

/** Every SELECT custom field that could serve as a factor for an object type. */
export async function GET(request: Request) {
  const objectType = new URL(request.url).searchParams.get("objectType") ?? "OPPORTUNITY"
  return withCardSortContext(request, async ({ workspaceId }) => {
    if (!isCardSortObjectType(objectType)) {
      throw new CardSortError("INVALID_VALUE", `Unknown objectType: ${objectType}`)
    }
    const factors = await listCardSortFactors({ workspaceId, objectType })
    return { factors }
  })
}
