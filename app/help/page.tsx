import { redirect } from "next/navigation";

export const dynamic = "force-static";

export default function HelpIndexPage() {
  redirect("/help/00-overview");
}
