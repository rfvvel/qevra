import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { businessCreateSchema, branchCreateSchema, serviceCreateSchema, PaymentMode, type BusinessCreate, type BranchCreate, type ServiceCreate } from '@qevra/contracts';
import { Button, ErrorNotice, Field, Success } from '../../components/ui';
import { errorMessage } from '../../lib/configuration-api';
type Props<T> = { initial?: T; save: (data: T) => Promise<void>; label?: string };
const text = (form: FormData, name: string) => String(form.get(name) ?? '');
function useSave<T>(schema: z.ZodType<T>, save: (data: T) => Promise<void>) {
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  async function submit(data: unknown) {
    setSaved(false); const parsed = schema.safeParse(data);
    if (!parsed.success) { setError(parsed.error.issues.map(i => i.message).join(' ')); return; }
    setBusy(true); setError(null);
    try { await save(parsed.data); setSaved(true); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  return { submit, feedback: <><ErrorNotice message={error} /><Success message={saved ? 'Changes saved.' : null} /></>, busy };
}
export function BusinessForm({ initial, save, label = 'Save business' }: Props<BusinessCreate>) {
  const form = useSave(businessCreateSchema, save);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    if (initial?.status === 'ACTIVE' && text(data,'status') === 'INACTIVE' && !window.confirm('Deactivate this business? Its public queues will become unavailable.')) return;
    void form.submit({ name: text(data,'name'), slug: text(data,'slug'), status: text(data,'status') });
  }
  return <form onSubmit={submit} className="space-y-4">
    <Field label="Business name"><input className="input" name="name" required maxLength={160} defaultValue={initial?.name} /></Field>
    <Field label="Business slug" hint="Lowercase letters, numbers and hyphens."><input className="input" name="slug" required maxLength={120} defaultValue={initial?.slug} /></Field>
    <Field label="Business status"><select className="input" name="status" defaultValue={initial?.status || 'ACTIVE'}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></Field>
    {form.feedback}<Button disabled={form.busy} type="submit">{form.busy ? 'Saving…' : label}</Button>
  </form>;
}
export function BranchForm({ initial, save, label = 'Save branch' }: Props<BranchCreate>) {
  const form = useSave(branchCreateSchema, save);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    if (initial && text(data,'public_slug') !== initial.public_slug && !window.confirm('Changing this slug changes the public queue URL. Printed QR codes and existing links will stop working. Continue?')) return;
    if (initial?.is_active && !data.has('is_active') && !window.confirm('Deactivate this branch? Customers will no longer be able to join its queues.')) return;
    void form.submit({ name: text(data,'name'), public_slug: text(data,'public_slug'), timezone: text(data,'timezone'), address: text(data,'address') || null, is_active: data.has('is_active') });
  }
  return <form onSubmit={submit} className="space-y-4">
    <Field label="Branch name"><input className="input" name="name" required maxLength={160} defaultValue={initial?.name} /></Field>
    <Field label="Public slug" hint="Changing this value changes the public branch link."><input className="input" name="public_slug" required maxLength={120} defaultValue={initial?.public_slug} /></Field>
    <Field label="Timezone"><input className="input" name="timezone" required defaultValue={initial?.timezone || 'Asia/Jakarta'} /></Field>
    <Field label="Address"><textarea className="input" name="address" rows={3} maxLength={1000} defaultValue={initial?.address || ''} /></Field>
    <label className="flex items-center gap-2 text-sm"><input name="is_active" type="checkbox" defaultChecked={initial?.is_active ?? true} />Branch active</label>
    {form.feedback}<Button disabled={form.busy} type="submit">{form.busy ? 'Saving…' : label}</Button>
  </form>;
}
export function ServiceForm({ initial, save, label = 'Save service' }: Props<ServiceCreate>) {
  const [mode, setMode] = useState(initial?.payment_mode || PaymentMode.NONE);
  const form = useSave(serviceCreateSchema, save);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    if (initial?.is_active && !data.has('is_active') && !window.confirm('Deactivate this service? Customers will no longer be able to join its queue.')) return;
    void form.submit({ name: text(data,'name'), description: text(data,'description') || null, price_amount: text(data,'price_amount'), currency: 'IDR', estimated_duration_minutes: Number(text(data,'estimated_duration_minutes')), queue_prefix: text(data,'queue_prefix'), payment_mode: mode, deposit_amount: mode === PaymentMode.DEPOSIT ? text(data,'deposit_amount') : null, is_active: data.has('is_active') });
  }
  return <form onSubmit={submit} className="space-y-4">
    <Field label="Service name"><input className="input" name="name" required maxLength={160} defaultValue={initial?.name} /></Field>
    <Field label="Description"><textarea className="input" name="description" rows={2} maxLength={3000} defaultValue={initial?.description || ''} /></Field>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="Price (IDR)" hint="Whole rupiah amount."><input className="input" name="price_amount" inputMode="numeric" required defaultValue={initial?.price_amount || '0'} /></Field>
    <Field label="Estimated duration (minutes)"><input className="input" name="estimated_duration_minutes" type="number" min={1} max={1440} step={1} required defaultValue={initial?.estimated_duration_minutes || 30} /></Field></div>
    <Field label="Queue prefix" hint="1–5 uppercase letters; unique within this branch."><input className="input" name="queue_prefix" required maxLength={5} defaultValue={initial?.queue_prefix} /></Field>
    <Field label="Payment mode"><select className="input" name="payment_mode" value={mode} onChange={event => setMode(event.target.value as PaymentMode)}><option value="NONE">None</option><option value="DEPOSIT">Deposit</option><option value="FULL">Full payment</option></select></Field>
    {mode === PaymentMode.DEPOSIT && <Field label="Deposit (IDR)"><input className="input" name="deposit_amount" inputMode="numeric" required defaultValue={initial?.deposit_amount || ''} /></Field>}
    <p className="text-xs text-slate-500">Real payment provider not integrated in MVP. Payment-enabled services use development mock checkout only.</p>
    <label className="flex items-center gap-2 text-sm"><input name="is_active" type="checkbox" defaultChecked={initial?.is_active ?? true} />Service active</label>
    {form.feedback}<Button disabled={form.busy} type="submit">{form.busy ? 'Saving…' : label}</Button>
  </form>;
}
