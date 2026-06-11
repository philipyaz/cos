import type { MessageRecord } from "@/lib/types";
import { IconMail, IconWhatsApp, IconJira, IconSpark, IconChat } from "@/components/icons";

export function SourceIcon({ source }: { source: MessageRecord["source"] }) {
  if (source === "gmail") return <IconMail className="w-3.5 h-3.5 text-rose-500" />;
  if (source === "whatsapp") return <IconWhatsApp className="w-3.5 h-3.5 text-green-500" />;
  if (source === "jira") return <IconJira className="w-3.5 h-3.5 text-sky-500" />;
  if (source === "agent") return <IconSpark className="w-3.5 h-3.5 text-violet-500" />;
  return <IconChat className="w-3.5 h-3.5 text-ink-400" />;
}
