import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { ApptRow } from '../../components/appts';
import { useOwner } from '../../components/owner';
import { ErrorBox, Field, Icon, Seg, Sheet, Spinner, TopBar, useAction, useLoad, useToast } from '../../components/ui';
import { describeAnswers } from '../../lib/consultation';
import { shrinkImage } from '../../lib/image';
import { fmt, fmtDay, fmtDayTime, todayInZone } from '../../lib/time';
import { firstName, friendlyError, money, whatsappLink } from '../../lib/text';
import type { ClientPhoto, ConsultationForm, PatchTest } from '../../lib/types';
import { Avatar, ClientSheet, Glyph } from './Clients';
import { BrandIcon } from '../../components/brand';

export function ClientView() {
  const { id = '' } = useParams();
  const { settings: s } = useOwner();
  const tz = s.timezone;
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(async () => {
    const [client, appts, tests, forms, photos] = await Promise.all([
      api.getClient(id), api.listClientAppointments(id), api.listPatchTests(id), api.listForms(id), api.listPhotos(id)]);
    return { client, appts, tests, forms, photos };
  }, [id]);
  const [sheet, setSheet] = useState<null | 'edit' | 'test' | 'delete' | 'consent' | 'health-delete'>(null);
  const [form, setForm] = useState<ConsultationForm | null>(null);
  const [photo, setPhoto] = useState<ClientPhoto | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [allergies, setAllergies] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const act = useAction();

  if (loading && !data) return <Spinner />;
  const c = data?.client;
  if (!c) return <div className="page"><TopBar title="Client" back /><ErrorBox error={error ?? new Error('not_found')} /></div>;

  const now = new Date().toISOString();
  const upcoming = data!.appts.filter((a) => a.starts_at >= now && (a.status === 'confirmed' || a.status === 'pending_deposit')).reverse();
  const past = data!.appts.filter((a) => !upcoming.includes(a));
  const spent = data!.appts.filter((a) => a.status === 'completed').reduce((n, a) => n + a.price_pence, 0);
  const visits = data!.appts.filter((a) => a.status === 'completed').length;
  const consented = !!c.health_consent_at;
  const hasHealth = consented || !!c.allergies || data!.tests.length > 0 || data!.forms.length > 0;

  async function saveNotes() {
    if (notes === null) return;
    if (await act.run(() => api.updateClient(c!.id, { notes: notes.trim() || null }))) { setNotes(null); toast('Saved'); reload(); }
  }
  async function saveAllergies() {
    if (allergies === null) return;
    if (await act.run(() => api.updateClient(c!.id, { allergies: allergies.trim() || null }))) { setAllergies(null); toast('Saved'); reload(); }
  }
  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    const ok = await act.run(async () => {
      for (const f of Array.from(files)) await api.uploadPhoto(c!.id, await shrinkImage(f), null, todayInZone(tz));
    });
    if (fileRef.current) fileRef.current.value = '';
    if (ok) toast(files.length > 1 ? `${files.length} photos added` : 'Photo added');
    reload(); // show whatever did upload, even if one failed
  }

  return (
    <div className="page stack od od-client">
      <TopBar title={c.full_name} back="/clients" right={<button className="btn small" onClick={() => setSheet('edit')}>Edit</button>} />

      <div className="card od-profile">
        <div className="od-profile-top">
          <Avatar name={c.full_name} size="lg" />
          <dl className="od-profile-contact">
            <div><dt>Mobile</dt><dd>{c.phone || '—'}</dd></div>
            <div><dt>Email</dt><dd>{c.email || '—'}</dd></div>
          </dl>
        </div>
        <dl className="od-mini-stats">
          <div><dt>Visits</dt><dd>{visits}</dd></div>
          <div><dt>Spent</dt><dd>{money(spent)}</dd></div>
          <div><dt>Client since</dt><dd>{fmtDay(c.created_at, tz)}</dd></div>
        </dl>
        {(c.phone_e164 || c.phone || c.email) && (
          <div className="od-contact">
            {c.phone_e164 && <a className="btn wa" href={whatsappLink(c.phone_e164, `Hi ${firstName(c.full_name)}, `)} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={20} /> WhatsApp</a>}
            {c.phone && <a className="btn" href={`tel:${c.phone.replace(/\s/g, '')}`}><Icon name="phone" size={20} /> Call</a>}
            {c.email && <a className="btn" href={`mailto:${c.email}`}><Icon name="mail" size={20} /> Email</a>}
          </div>
        )}
      </div>

      {c.allergies && allergies === null && (
        <div className="od-allergy">
          <span className="od-allergy-ic" aria-hidden="true" />
          <div className="grow">
            <div className="od-allergy-label">Allergies</div>
            <div className="od-allergy-text">{c.allergies}</div>
          </div>
        </div>
      )}

      <Link className="btn primary block od-book" to={`/appointments/new?client=${c.id}`}><Icon name="plus" size={20} /> Book an appointment</Link>

      <label className="check card od-regular">
        <input type="checkbox" checked={c.is_regular} disabled={act.busy}
          onChange={async (e) => { const v = e.target.checked; if (await act.run(() => api.updateClient(c.id, { is_regular: v }))) { toast(v ? 'Marked as a regular' : 'Updated'); reload(); } }} />
        <span>Regular client — never asked for a <span className="od-nowrap">new-client</span> deposit<br />
          <span className="sub">Tick this for regulars you’ve moved across from your old booking app.</span></span>
      </label>

      <div className="section-title">Notes</div>
      <div className="card stack od-client-notes">
        {notes !== null ? (
          <>
            <Field label="Notes (shape, colours, preferences…)"><textarea value={notes} maxLength={5000} onChange={(e) => setNotes(e.target.value)} /></Field>
            <div className="btn-row"><button className="btn" onClick={() => setNotes(null)}>Cancel</button><button className="btn primary" disabled={act.busy} onClick={saveNotes}>Save</button></div>
          </>
        ) : (
          <>
            {c.notes ? <p className="od-note-text">{c.notes}</p> : <p className="sub">No notes yet.</p>}
            <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setNotes(c.notes ?? '')}><Glyph name="pencil" size={16} /> Edit notes</button>
          </>
        )}
      </div>

      <div className="section-title">Health information</div>
      <div className="card stack od-health">
        {consented ? (
          <div className="od-consent">
            <span className="od-ic ok small" aria-hidden="true"><BrandIcon name="shield-heart" size={18} /></span>
            <p className="sub">Consent to keep health information: <span className="od-nowrap">{fmtDay(c.health_consent_at!, tz)}</span>{c.health_consent_note ? ` · ${c.health_consent_note}` : ''}</p>
          </div>
        ) : (
          <div className="notice warn">
            No consent recorded, so allergies and patch tests can’t be saved yet. New clients give consent on the online form;
            for anyone else, send them the form link from their next appointment, or record consent they’ve given you in writing.
            <div style={{ marginTop: 8 }}><button className="btn small" onClick={() => setSheet('consent')}>Record consent</button></div>
          </div>
        )}
        {allergies !== null ? (
          <>
            <Field label="Allergies / sensitivities"><textarea value={allergies} maxLength={2000} onChange={(e) => setAllergies(e.target.value)} /></Field>
            <div className="btn-row"><button className="btn" onClick={() => setAllergies(null)}>Cancel</button><button className="btn primary" disabled={act.busy} onClick={saveAllergies}>Save</button></div>
          </>
        ) : consented && (
          <>
            <div className="od-subhead">
              <span className={`od-ic small ${c.allergies ? 'danger' : 'lilac'}`} aria-hidden="true"><Glyph name="alert" size={18} /></span>
              <h3>Allergies</h3>
              <button className="btn small" onClick={() => setAllergies(c.allergies ?? '')}>{c.allergies ? 'Edit allergies' : 'Add allergies'}</button>
            </div>
            <p className="sub od-none">{c.allergies ? 'Shown in the alert at the top of this page.' : 'No allergies recorded.'}</p>
          </>
        )}

        <div className="od-subhead">
          <span className="od-ic small lilac" aria-hidden="true"><Glyph name="flask" size={18} /></span>
          <h3>Patch tests</h3>
          <button className="btn small" disabled={!consented} onClick={() => setSheet('test')}>Add test</button>
        </div>
        {data!.tests.length === 0 ? <p className="sub od-none">No patch test recorded.</p> : (
          <ul className="od-tests">
            {data!.tests.map((t) => <PatchRow key={t.id} t={t} tz={tz} onDeleted={reload} />)}
          </ul>
        )}

        <div className="od-subhead">
          <span className="od-ic small lilac" aria-hidden="true"><Glyph name="doc" size={18} /></span>
          <h3>Consultation forms</h3>
        </div>
        {data!.forms.length === 0 ? <p className="sub od-none">None yet. New clients fill one in when they book online.</p> : (
          <ul className="od-forms">
            {data!.forms.map((f) => {
              const flags = describeAnswers(f.answers).filter((r) => r.flag).length;
              return (
                <li key={f.id}><button className="od-form-row" onClick={() => setForm(f)}>
                  <span className={`od-form-ic${flags ? ' flagged' : ''}`} aria-hidden="true"><Glyph name="doc" size={20} /></span>
                  <div className="grow"><div className="title">Form · {fmtDay(f.submitted_at, tz)}</div>
                    <div className="meta">{flags ? <span className="flag">{flags} answer{flags === 1 ? '' : 's'} to check</span> : 'Nothing flagged'}{'\u00a0· '}<span className="od-signed">signed {f.signed_name}</span></div></div>
                  <span className="chev"><Icon name="chev" size={18} /></span>
                </button></li>
              );
            })}
          </ul>
        )}
        {hasHealth && (
          <button className="btn danger small od-health-delete" onClick={() => setSheet('health-delete')}>Delete health information only</button>
        )}
      </div>

      <div className="od-photos-head">
        <div className="section-title">Nail photos · {data!.photos.length}</div>
        <label className="btn small od-add-photos">
          <Icon name="camera" size={18} /> Add photos
          <input ref={fileRef} className="visually-hidden" type="file" accept="image/*" multiple onChange={(e) => addPhotos(e.target.files)} />
        </label>
      </div>
      {act.busy && <p className="sub">Uploading…</p>}
      <ErrorBox error={act.error} />
      {data!.photos.length === 0 ? (
        <div className="card od-photos-empty">
          <span className="od-ic" aria-hidden="true"><Icon name="camera" size={21} /></span>
          <p className="sub">Photos of each set appear here. Only you can see them.</p>
        </div>
      ) : (
        <div className="photo-grid od-photo-grid">
          {data!.photos.map((p) => (
            <button key={p.id} onClick={() => setPhoto(p)} aria-label={`Photo from ${p.taken_on}`}>
              {p.url ? <img src={p.url} alt="" loading="lazy" /> : null}
            </button>
          ))}
        </div>
      )}

      {upcoming.length > 0 && <>
        <div className="section-title">Upcoming</div>
        <div className="card tight"><ul className="list">{upcoming.map((a) => <ApptRow key={a.id} a={a} tz={tz} showDate={(iso) => fmtDay(iso, tz)} />)}</ul></div>
      </>}
      <div className="section-title">History</div>
      <div className="card tight">
        {past.length ? <ul className="list">{past.map((a) => <ApptRow key={a.id} a={a} tz={tz} showDate={(iso) => fmtDay(iso, tz)} />)}</ul> : <div className="empty">No past appointments.</div>}
      </div>

      <button className="btn danger od-delete" onClick={() => setSheet('delete')}><Icon name="trash" size={18} /> Delete client and all their records</button>

      {sheet === 'edit' && <ClientSheet initial={c} onClose={() => setSheet(null)} onSaved={reload} />}
      {sheet === 'test' && <PatchTestSheet clientId={c.id} tz={tz} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); reload(); }} />}
      {sheet === 'consent' && <ConsentSheet clientId={c.id} tz={tz} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); toast('Consent recorded'); reload(); }} />}
      {sheet === 'health-delete' && (
        <Sheet title="Delete health information?" onClose={() => setSheet(null)}>
          <div className="stack">
            <p>Use this when {firstName(c.full_name)} withdraws consent. It deletes their consultation forms, patch tests and allergy notes, and the consent record. Their bookings, notes and photos stay.</p>
            <ErrorBox error={act.error} />
            <button className="btn danger solid block" disabled={act.busy}
              onClick={async () => { if (await act.run(() => api.deleteHealthData(c.id))) { setSheet(null); toast('Health information deleted'); reload(); } }}>
              {act.busy ? 'Deleting…' : 'Delete health information'}
            </button>
          </div>
        </Sheet>
      )}
      {sheet === 'delete' && (
        <Sheet title={`Delete ${c.full_name}?`} onClose={() => setSheet(null)}>
          <div className="stack">
            <p>This permanently deletes their details, appointments, consultation forms, patch tests and photos. Use it when a client asks you to delete their data.</p>
            <p className="sub">Money already received stays in your takings (with their name) because you must keep tax records.</p>
            <ErrorBox error={act.error} />
            <button className="btn danger solid block" disabled={act.busy}
              onClick={async () => { if (await act.run(() => api.deleteClient(c.id))) { toast('Client deleted'); nav('/clients', { replace: true }); } }}>
              {act.busy ? 'Deleting…' : 'Delete permanently'}
            </button>
          </div>
        </Sheet>
      )}
      {form && (
        <Sheet title={`Consultation form · ${fmtDay(form.submitted_at, tz)}`} onClose={() => setForm(null)}>
          <div className="stack od-form-sheet">
            {describeAnswers(form.answers).map((r) => (
              <div key={r.question} className={`od-qa${r.flag ? ' flagged' : ''}`}><div className="od-qa-q">{r.question}</div><div className={r.flag ? 'flag od-qa-a' : 'od-qa-a'}>{r.answer}</div></div>
            ))}
            <hr className="divider" />
            <p className="sub">Signed “{form.signed_name}” on {fmtDayTime(form.submitted_at, tz)}, with consent to store health information.</p>
            <button className="btn block" onClick={() => setForm(null)}>Done</button>
          </div>
        </Sheet>
      )}
      {photo && (
        <Sheet title={`Photo · ${fmtDay(photo.taken_on + 'T12:00:00Z', tz)}`} onClose={() => setPhoto(null)}>
          <div className="stack">
            {photo.url && <img className="od-photo-full" src={photo.url} alt="" />}
            <button className="btn danger" disabled={act.busy}
              onClick={async () => { if (window.confirm('Delete this photo?') && await act.run(() => api.deletePhoto(photo))) { setPhoto(null); reload(); } }}>
              <Icon name="trash" size={20} /> Delete photo
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function PatchRow({ t, tz, onDeleted }: { t: PatchTest; tz: string; onDeleted: () => void }) {
  const toast = useToast();
  const label = t.result === 'pass' ? 'No reaction' : t.result === 'reaction' ? 'Reaction' : 'Waiting for result';
  const tone = t.result === 'pass' ? 'ok' : t.result === 'reaction' ? 'danger' : 'warn';
  return (
    <li className={`od-test od-test-${tone}`}>
      <div className="grow">
        <div className="od-test-head">
          <span className="od-test-date">{fmt(`${t.tested_on}T12:00:00Z`, 'EEE d MMM yyyy', tz)}</span>
          <span className={`chip ${tone}`}>{label}</span>
        </div>
        {(t.product || t.notes) && <div className="od-test-detail">{[t.product, t.notes].filter(Boolean).join(' · ')}</div>}
      </div>
      <button className="icon-btn" aria-label="Delete patch test"
        onClick={async () => {
          if (!window.confirm('Delete this patch test record?')) return;
          try { await api.deletePatchTest(t.id); onDeleted(); } catch (e) { toast(friendlyError(e)); }
        }}>
        <Icon name="trash" size={20} />
      </button>
    </li>
  );
}

function ConsentSheet({ clientId, tz, onClose, onSaved }: { clientId: string; tz: string; onClose: () => void; onSaved: () => void }) {
  const [how, setHow] = useState('Paper consultation form');
  const [on, setOn] = useState(todayInZone(tz));
  const { busy, error, run } = useAction();
  return (
    <Sheet title="Record consent" onClose={onClose}>
      <div className="stack">
        <p className="sub">Only record consent the client has actually given you in writing — to you keeping their health and allergy information so treatments are safe. Keep the paper form or message.</p>
        <Field label="How they gave it">
          <select value={how} onChange={(e) => setHow(e.target.value)}>
            <option>Paper consultation form</option>
            <option>WhatsApp message</option>
            <option>Email</option>
          </select>
        </Field>
        <Field label="Date"><input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy}
          onClick={async () => { if (await run(() => api.updateClient(clientId, { health_consent_at: new Date(`${on}T12:00:00Z`).toISOString(), health_consent_note: how }))) onSaved(); }}>
          {busy ? 'Saving…' : 'Record consent'}
        </button>
      </div>
    </Sheet>
  );
}

function PatchTestSheet({ clientId, tz, onClose, onSaved }: { clientId: string; tz: string; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ tested_on: todayInZone(tz), product: '', result: 'pass' as PatchTest['result'], notes: '' });
  const { busy, error, run } = useAction();
  return (
    <Sheet title="Record a patch test" onClose={onClose}>
      <div className="stack">
        <Field label="Date tested"><input type="date" value={f.tested_on} onChange={(e) => setF({ ...f, tested_on: e.target.value })} /></Field>
        <Field label="Product(s)"><input type="text" value={f.product} maxLength={200} placeholder="e.g. HEMA-free builder gel" onChange={(e) => setF({ ...f, product: e.target.value })} /></Field>
        <div className="field">
          <span aria-hidden="true">Result</span>
          <Seg label="Result" value={f.result} onChange={(result) => setF({ ...f, result })}
            options={[{ value: 'pass', label: 'No reaction' }, { value: 'reaction', label: 'Reaction' }, { value: 'pending', label: 'Waiting' }]} />
        </div>
        <Field label="Notes"><input type="text" value={f.notes} maxLength={1000} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy}
          onClick={async () => { if (await run(() => api.addPatchTest({ client_id: clientId, tested_on: f.tested_on, product: f.product.trim() || null, result: f.result, notes: f.notes.trim() || null }))) onSaved(); }}>
          {busy ? 'Saving…' : 'Save patch test'}
        </button>
      </div>
    </Sheet>
  );
}
