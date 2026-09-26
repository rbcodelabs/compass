import { afterEach, describe, expect, it, vi } from "vitest"
const clients=vi.hoisted(()=>{
 const model=()=>({findFirst:vi.fn().mockResolvedValue({id:"item"}),findUnique:vi.fn().mockResolvedValue({id:"item",workspaceId:"ws",status:"EXPLORING"}),update:vi.fn().mockResolvedValue({id:"item",workspaceId:"ws",status:"VALIDATED"})})
 const readiness={findFirst:vi.fn().mockResolvedValue(null)}
 const raw={opportunity:model(),workspaceUpdatesState:{...readiness,upsert:vi.fn().mockResolvedValue({revision:1})},workspaceUpdateEvent:{...readiness,create:vi.fn()},workspaceUpdatesReadState:readiness,$transaction:vi.fn()}
 const activity={...raw,opportunity:model(),$transaction:vi.fn()}
 raw.$transaction.mockImplementation(callback=>callback(raw))
 activity.$transaction.mockImplementation(callback=>callback(activity))
 return {raw,activity}
})
vi.mock("@/lib/db",()=>({default:()=>clients.raw}))
vi.mock("@/lib/analytics/activity",()=>({getHumanActivityPrisma:()=>clients.activity,getMcpActivityPrisma:()=>clients.activity}))
import { updateEntityField } from "@/lib/entity-mutations"
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks()})
describe("inline analytics and Updates composition",()=>{
 it.each(["0","1"])("preserves the human activity client with Updates flag %s",async flag=>{
  vi.stubEnv("WORKSPACE_UPDATES_ENABLED",flag)
  expect(await updateEntityField("opportunity","item","ws","status","ACTIVE",{kind:"USER",id:"user"})).toEqual({ok:true})
  expect(clients.activity.opportunity.update).toHaveBeenCalledTimes(1)
  expect(clients.raw.opportunity.update).not.toHaveBeenCalled()
 })
})
