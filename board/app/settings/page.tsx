import { redirect } from "next/navigation";

// /settings has been folded into /security — the guard sender-trust whitelist that
// used to live here is now the third section of the Security page, alongside the
// guard-status card and the quarantine review queue. This redirect keeps the old URL
// alive (it 308s to /security) so any bookmark or stale link does not 404.
export default function SettingsPage() {
  redirect("/security");
}
