import type { ReactNode, ButtonHTMLAttributes } from 'react';
export function PageTitle({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <div className="mb-7 flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-3xl font-semibold tracking-tight">{title}</h1>{description && <p className="mt-2 max-w-2xl text-slate-500">{description}</p>}</div>{actions}</div>;
}
export function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">{title && <h2 className="mb-5 text-lg font-semibold">{title}</h2>}{children}</section>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="block text-sm font-medium text-slate-700"><span className="mb-1.5 block">{label}</span>{children}{hint && <span className="mt-1 block text-xs font-normal text-slate-500">{hint}</span>}</label>;
}
export function Button({ children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={'button ' + className}>{children}</button>;
}
export function ErrorNotice({ message }: { message?: string | null }) { return message ? <p role="alert" className="my-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{message}</p> : null; }
export function Success({ message }: { message?: string | null }) { return message ? <p role="status" className="my-3 text-sm text-teal-800">{message}</p> : null; }
export function Loading() { return <p role="status" className="py-8 text-slate-500">Loading…</p>; }
export function Badge({ active }: { active: boolean }) { return <span className={'rounded-full px-2.5 py-1 text-xs font-medium ' + (active ? 'bg-teal-50 text-teal-800' : 'bg-slate-100 text-slate-500')}>{active ? 'Active' : 'Inactive'}</span>; }
export function money(value: string) { return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(BigInt(value)); }
