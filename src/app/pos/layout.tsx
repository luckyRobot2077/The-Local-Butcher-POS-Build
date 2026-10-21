import { PosShell } from "@/components/pos/pos-shell";

export default function PosLayout({ children }: { children: React.ReactNode }) {
  return <PosShell>{children}</PosShell>;
}
