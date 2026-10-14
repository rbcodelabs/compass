import type { Metadata } from "next";
import { ApiExplorer } from "@/components/api-explorer/api-explorer";

export const metadata: Metadata = {
  title: "API Explorer — Compass Developer",
  description:
    "Browse the Compass OpenAPI contract and explicitly try authenticated read requests.",
};
export default function Page() {
  return <ApiExplorer />;
}
