import { useState, useEffect, useRef } from 'react';
import {
  Calendar, Scissors, Users, Image as ImageIcon,
  LogOut, Plus, Pencil, Trash2, Check, X, Upload, User, Loader2, ChevronDown,
  Settings, Star, MessageCircle, Smartphone, Moon, Copy, Link2, AlertCircle,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { uploadBusinessAvatar } from '../lib/auth';
import { track } from '../lib/posthog';
import { getBusinessTheme, getOwnerBio } from '../lib/getBusinessTheme';
import { normalizeNgPhone } from '../lib/phone';
import { reminderMessage } from '../lib/reminderMessages';
import { useCopyToClipboard } from '../lib/useCopyToClipboard';
import SabiLogo from '../components/SabiLogo';
import PayoutSetup from '../components/PayoutSetup';
import { openPaystackPopup, buildPaystackReference } from '../components/PaystackPayment';
import { isSubscriptionActive, daysUntilExpiry } from '../lib/payments';
import { PRICING } from '../config/pricing';
import { SUPPORT_WHATSAPP } from '../config/support';

const TABS = [
  { id: 'bookings',  label: 'Bookings',  Icon: Calendar  },
  { id: 'services',  label: 'Services',  Icon: Scissors  },
  { id: 'clients',   label: 'Clients',   Icon: Users     },
  { id: 'gallery',   label: 'Gallery',   Icon: ImageIcon },
  { id: 'settings',  label: 'Settings',  Icon: Settings  },
];

const CATEGORY_OPTIONS = {
  nail_studio:   [['nails','Nails'],['lash','Lash'],['other','Other']],
  lash_studio:   [['lash','Lash'],['nails','Nails'],['other','Other']],
  spa:           [['spa','Spa'],['body','Body'],['facial','Facial'],['massage','Massage'],['waxing','Waxing'],['other','Other']],
  barbershop:    [['barber','Barber'],['hair','Hair'],['beard','Beard'],['other','Other']],
  mua:           [['makeup','Makeup'],['bridal','Bridal'],['other','Other']],
  tailor:        [['fashion','Fashion'],['alterations','Alterations'],['other','Other']],
  photography:   [['portrait','Portrait'],['events','Events'],['other','Other']],
  home_services: [['plumbing','Plumbing'],['electrical','Electrical'],['cleaning','Cleaning'],['other','Other']],
  tutor:         [['primary','Primary'],['secondary','Secondary'],['jamb','JAMB'],['waec','WAEC'],['other','Other']],
  fitness:       [['training','Training'],['nutrition','Nutrition'],['wellness','Wellness'],['other','Other']],
  events:        [['mc','MC'],['dj','DJ'],['decoration','Decoration'],['catering','Catering'],['other','Other']],
  other:         [['general','General'],['other','Other']],
};

function buildClientWhatsAppUrl(phone, status, booking) {
  const number = normalizeNgPhone(phone);
  if (!number) return null;
  const { client_name, service_name, date, time, ampm } = booking;
  let readableDate = date ?? '';
  if (date) {
    const [y, m, d] = date.split('-').map(Number);
    readableDate = new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  const timeStr = [time, ampm].filter(Boolean).join(' ');
  const message = status === 'confirmed'
    ? ['✅ Booking Confirmed!','',`Hi ${client_name}, your appointment has been confirmed.`,'',`Service: ${service_name}`,`Date: ${readableDate}`,`Time: ${timeStr}`,'','We look forward to seeing you! If you need to reschedule, please contact us.'].join('\n')
    : ['❌ Booking Update','',`Hi ${client_name}, unfortunately we are unable to accommodate your booking on ${readableDate} at ${timeStr}.`,'','Please reach out to reschedule at a more convenient time. We apologize for any inconvenience.'].join('\n');
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

function buildShareMessage(businessName, ownerName, businessType, link) {
  const first = (ownerName || '').trim().split(/\s+/)[0];
  const intro = first ? `Hi! I'm ${first} from ${businessName}.` : `Hi! This is ${businessName}.`;
  return `${intro} ${getOwnerBio(businessType)} Book your appointment here: ${link}`;
}

function buildActivationSupportMessage(businessName, reference) {
  return `Hi, my Danda payment for ${businessName || 'my business'} didn't activate automatically. Reference: ${reference}. Please help me activate my account.`;
}

// ── Shared input style ────────────────────────────────────────────────────────

const inputCls = 'bg-sabi-dark border border-sabi-border rounded-lg px-3 py-2 text-white text-sm placeholder:text-sabi-muted outline-none focus:border-sabi-green transition-colors';
const selectCls = `${inputCls} cursor-pointer`;

// ── Main component ────────────────────────────────────────────────────────────

export default function OwnerDashboard({ businessId, onLogout, onViewPublicPage }) {
  const [activeTab, setActiveTab] = useState('bookings');

  const [bookings,       setBookings]       = useState([]);
  const [bookingsLoading,setBookingsLoading]= useState(true);
  const [services,       setServices]       = useState([]);
  const [servicesLoading,setServicesLoading]= useState(true);
  const [editingId,      setEditingId]      = useState(null);
  const [editDraft,      setEditDraft]      = useState({});
  const [addingService,  setAddingService]  = useState(false);
  const [newSvc,         setNewSvc]         = useState({ name: '', category: 'nails', price: '' });
  const [svcError,       setSvcError]       = useState('');
  const [clients,        setClients]        = useState([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [gallery,        setGallery]        = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(true);
  const [imgCaption,     setImgCaption]     = useState('');
  const [imgError,       setImgError]       = useState('');
  const [addingImg,      setAddingImg]      = useState(false);
  const [avatarUrl,      setAvatarUrl]      = useState(null);
  const [avatarUploading,setAvatarUploading]= useState(false);
  const [avatarError,    setAvatarError]    = useState('');
  const [businessType,   setBusinessType]   = useState('other');
  const [subStatus,      setSubStatus]      = useState('inactive');
  const [subExpiresAt,   setSubExpiresAt]   = useState(null);
  const [bizLoaded,      setBizLoaded]      = useState(false);
  const [bizSlug,        setBizSlug]        = useState('');
  const [ownerEmail,     setOwnerEmail]     = useState('');
  const [renewalLoading, setRenewalLoading] = useState(false);
  const [activationError,setActivationError]= useState(null); // { reference } | null
  const activationRefRef = useRef(null);
  const { copied: activationRefCopied, copy: copyActivationRef } = useCopyToClipboard();
  const [paymentPending, setPaymentPending] = useState(null); // { reference } | null
  const pendingIntervalRef = useRef(null);
  const [showEarningsHistory, setShowEarningsHistory] = useState(false);
  const [settings,       setSettings]       = useState({ name: '', owner_name: '', tagline: '', whatsapp: '' });
  const [savedSettings,  setSavedSettings]  = useState({ name: '', owner_name: '', tagline: '', whatsapp: '' });
  const [payout,         setPayout]         = useState({ enabled: false });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSuccess,setSettingsSuccess]= useState(false);
  const [settingsError,  setSettingsError]  = useState('');
  const settingsButtonRef = useRef(null);
  const bookingLinkRef    = useRef(null);
  const { copied: linkCopied, copy: copyBookingLink } = useCopyToClipboard();

  const categoryOptions = CATEGORY_OPTIONS[businessType] ?? CATEGORY_OPTIONS.other;
  const theme = getBusinessTheme(businessType);

  const _now = new Date();
  const today = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`;
  const _tomorrow = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate() + 1);
  const tomorrowStr = `${_tomorrow.getFullYear()}-${String(_tomorrow.getMonth()+1).padStart(2,'0')}-${String(_tomorrow.getDate()).padStart(2,'0')}`;
  const currentMonth = today.slice(0, 7);
  const confirmed = bookings.filter(b => b.status === 'confirmed');
  const todayEarnings   = confirmed.filter(b => b.date === today).reduce((s, b) => s + (b.price || 0), 0);
  const monthlyEarnings = confirmed.filter(b => typeof b.date === 'string' && b.date.startsWith(currentMonth)).reduce((s, b) => s + (b.price || 0), 0);
  const lifetimeEarnings = confirmed.reduce((s, b) => s + (b.price || 0), 0);
  const last6Months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(_now.getFullYear(), _now.getMonth() - i, 1);
    const prefix = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    return { prefix, label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) };
  });
  const earningsByMonth = last6Months.map(({ prefix, label }) => ({
    prefix, label,
    total: confirmed.filter(b => typeof b.date === 'string' && b.date.startsWith(prefix)).reduce((s, b) => s + (b.price || 0), 0),
  }));
  const startsAtMs = b => b.starts_at ? new Date(b.starts_at).getTime() : Infinity;
  const todayBookings = [...bookings].filter(b => b.date === today).sort((a, b) => startsAtMs(a) - startsAtMs(b));
  const tomorrowBookings = [...bookings]
    .filter(b => b.date === tomorrowStr && b.status === 'confirmed')
    .sort((a, b) => startsAtMs(a) - startsAtMs(b));

  const isSettingsDirty = Object.keys(savedSettings).some(k => settings[k] !== savedSettings[k]);
  const bookingLink = bizSlug ? `${window.location.origin}/${bizSlug}` : '';

  const subBizSnap = { subscription_status: subStatus, plan_expires_at: subExpiresAt };
  const subActive  = isSubscriptionActive(subBizSnap);
  const daysLeft   = daysUntilExpiry(subBizSnap);
  const showRenewalBanner  = bizLoaded && subActive && daysLeft <= 7;
  const showExpiredOverlay = bizLoaded && !subActive;
  const overlayMode        = subExpiresAt === null ? 'activate' : 'renew';

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.email) setOwnerEmail(session.user.email);
    });
  }, []);

  function stopPendingCheck() {
    clearInterval(pendingIntervalRef.current);
    pendingIntervalRef.current = null;
    setPaymentPending(null);
  }

  // Stop polling if the component unmounts mid-check (e.g. the owner logs
  // out while a transfer is still pending).
  useEffect(() => () => clearInterval(pendingIntervalRef.current), []);

  // Popup closed without a Paystack callback — either the owner backed
  // out, or (very commonly, for a bank transfer) they left to their
  // banking app and the popup was gone by the time it settled. There's no
  // way to tell those two apart from here, which is exactly why the
  // pending message can't guess either way — it just watches for the
  // paystack-webhook Edge Function to activate the account in the
  // background and reflects that the moment it happens.
  function beginPendingCheck(reference) {
    clearInterval(pendingIntervalRef.current);
    setPaymentPending({ reference });
    const intervalMs = 4000;
    const maxChecks = 75; // ~5 minutes
    let checks = 0;
    pendingIntervalRef.current = setInterval(async () => {
      checks += 1;
      const { data: biz } = await supabase.from('businesses').select('subscription_status, plan_expires_at').eq('id', businessId).single();
      if (biz?.subscription_status === 'active') {
        setSubStatus(biz.subscription_status);
        setSubExpiresAt(biz.plan_expires_at ?? null);
        stopPendingCheck();
        return;
      }
      // Timing out doesn't mean it failed — the webhook can still arrive
      // later (Paystack's own detection can take a few minutes). It just
      // stops asking every few seconds; a fresh page load will pick up
      // the real state whenever it does land.
      if (checks >= maxChecks) clearInterval(pendingIntervalRef.current);
    }, intervalMs);
  }

  // Verifies a Paystack reference server-side and activates the
  // subscription — called both right after a successful Paystack popup and
  // from the failure banner's "Try Again" button, so it must be safe to
  // call more than once with the same reference (the Edge Function treats
  // a reference already attached to this business as a no-op success).
  async function verifyPayment(reference) {
    stopPendingCheck();
    setActivationError(null);
    setRenewalLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('verify-payment', {
        body: { businessId, reference },
      });
      if (error || data?.error) {
        throw new Error(data?.error || error?.message || 'Verification failed');
      }
      const { data: biz } = await supabase.from('businesses').select('subscription_status, plan_expires_at').eq('id', businessId).single();
      if (biz) { setSubStatus(biz.subscription_status ?? 'inactive'); setSubExpiresAt(biz.plan_expires_at ?? null); }
    } catch (err) {
      console.error('[OwnerDashboard] payment verification failed:', err);
      setActivationError({ reference });
    } finally {
      setRenewalLoading(false);
    }
  }

  function handleRenew() {
    if (!businessId || !ownerEmail) return;
    stopPendingCheck();
    setActivationError(null);
    setRenewalLoading(true);
    const reference = buildPaystackReference(businessId);
    openPaystackPopup({
      email: ownerEmail, businessId, reference,
      onSuccess: (response) => verifyPayment(response.reference),
      onClose: () => { setRenewalLoading(false); beginPendingCheck(reference); },
    });
  }

  useEffect(() => {
    if (!businessId) return;
    async function loadAll() {
      const [bRes, sRes, cRes, gRes, bizRes] = await Promise.all([
        supabase.from('bookings').select('*').eq('business_id', businessId).order('created_at', { ascending: false }),
        supabase.from('services').select('*').eq('business_id', businessId).order('category').order('name'),
        supabase.from('clients').select('*').eq('business_id', businessId).order('visit_count', { ascending: false }),
        supabase.from('gallery').select('*').eq('business_id', businessId).order('created_at', { ascending: false }),
        supabase.from('businesses').select('avatar_url, business_type, name, owner_name, tagline, whatsapp, subscription_status, plan_expires_at, slug, payouts_enabled, payout_bank_name, payout_bank_code, payout_account_last4, payout_account_name').eq('id', businessId).single(),
      ]);
      setBookings(bRes.data || []);       setBookingsLoading(false);
      setServices(sRes.data || []);       setServicesLoading(false);
      setClients(cRes.data || []);        setClientsLoading(false);
      setGallery(gRes.data || []);        setGalleryLoading(false);
      if (bizRes.data) {
        const biz = bizRes.data;
        if (biz.avatar_url)   setAvatarUrl(biz.avatar_url);
        if (biz.business_type) {
          setBusinessType(biz.business_type);
          const firstCat = (CATEGORY_OPTIONS[biz.business_type] ?? CATEGORY_OPTIONS.other)[0][0];
          setNewSvc(s => ({ ...s, category: firstCat }));
        }
        const loadedSettings = { name: biz.name ?? '', owner_name: biz.owner_name ?? '', tagline: biz.tagline ?? '', whatsapp: biz.whatsapp ?? '' };
        setSettings(loadedSettings);
        setSavedSettings(loadedSettings);
        setSubStatus(biz.subscription_status ?? 'inactive');
        setSubExpiresAt(biz.plan_expires_at ?? null);
        setBizSlug(biz.slug ?? '');
        setPayout({ enabled: !!biz.payouts_enabled, bank_name: biz.payout_bank_name, bank_code: biz.payout_bank_code, account_last4: biz.payout_account_last4, account_name: biz.payout_account_name });
        setBizLoaded(true);
      }
    }
    loadAll();
    const channel = supabase.channel(`bookings-${businessId}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bookings', filter: `business_id=eq.${businessId}` }, (payload) => setBookings(prev => [payload.new, ...prev])).subscribe();
    return () => supabase.removeChannel(channel);
  }, [businessId]);

  async function setBookingStatus(id, status) {
    const booking = bookings.find(b => b.id === id);
    const original = booking?.status;
    setBookings(bs => bs.map(b => b.id === id ? { ...b, status } : b));
    const { error: bookingErr } = await supabase.from('bookings').update({ status }).eq('id', id);
    if (bookingErr) { setBookings(bs => bs.map(b => b.id === id ? { ...b, status: original } : b)); return; }
    if (status !== 'confirmed' || !booking) return;
    track('booking_confirmed', { booking_id: id, business_id: businessId });
    const { client_name, client_phone, service_name, date } = booking;
    const initials = (client_name ?? '').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
    const { data: existing, error: selectErr } = await supabase.from('clients').select('id, visit_count').eq('business_id', businessId).eq('name', client_name).eq('phone', client_phone).maybeSingle();
    if (selectErr) console.error('[ClientUpsert] select failed:', selectErr.code, selectErr.message);
    if (existing) {
      const updated = { visit_count: (existing.visit_count || 1) + 1, last_service: service_name, last_visit: date };
      const { error: updateErr } = await supabase.from('clients').update(updated).eq('id', existing.id);
      if (!updateErr) setClients(cs => cs.map(c => c.id === existing.id ? { ...c, ...updated } : c));
    } else {
      const { data: newClient, error: insertErr } = await supabase.from('clients').insert({ business_id: businessId, name: client_name, phone: client_phone, initials, visit_count: 1, last_service: service_name, last_visit: date }).select().single();
      if (!insertErr && newClient) setClients(cs => [newClient, ...cs]);
    }
  }

  async function removeBooking(id) {
    const backup = bookings.find(b => b.id === id);
    setBookings(bs => bs.filter(b => b.id !== id));
    const { error } = await supabase.from('bookings').delete().eq('id', id);
    if (error && backup) setBookings(bs => [backup, ...bs]);
  }

  // Optimistic — we can't confirm the client actually received it, so this
  // only records that the owner tapped a reminder button ("Reminded").
  async function markReminderSent(id) {
    const previous = bookings.find(b => b.id === id)?.reminder_sent_at ?? null;
    const nowIso = new Date().toISOString();
    setBookings(bs => bs.map(b => b.id === id ? { ...b, reminder_sent_at: nowIso } : b));
    const { error } = await supabase.from('bookings').update({ reminder_sent_at: nowIso }).eq('id', id);
    if (error) setBookings(bs => bs.map(b => b.id === id ? { ...b, reminder_sent_at: previous } : b));
  }

  function startEdit(svc) { setEditingId(svc.id); setEditDraft({ name: svc.name, category: svc.category, price: String(svc.price) }); }
  async function saveEdit(id) {
    const price = parseInt(editDraft.price, 10);
    if (!editDraft.name?.trim() || isNaN(price) || price <= 0) return;
    const patch = { name: editDraft.name.trim(), category: editDraft.category, price };
    setServices(ss => ss.map(s => s.id === id ? { ...s, ...patch } : s));
    setEditingId(null);
    await supabase.from('services').update(patch).eq('id', id);
  }
  async function toggleActive(id, current) {
    setServices(ss => ss.map(s => s.id === id ? { ...s, active: !current } : s));
    await supabase.from('services').update({ active: !current }).eq('id', id);
  }
  async function removeService(id) { setServices(ss => ss.filter(s => s.id !== id)); await supabase.from('services').delete().eq('id', id); }
  async function submitNewService() {
    setSvcError('');
    const price = parseInt(newSvc.price, 10);
    if (!newSvc.name.trim()) return setSvcError('Service name is required');
    if (isNaN(price) || price <= 0) return setSvcError('Enter a valid price');
    const { data, error } = await supabase.from('services').insert({ business_id: businessId, name: newSvc.name.trim(), category: newSvc.category, price, active: true }).select().single();
    if (error) return setSvcError('Could not save service');
    track('service_added', { service_name: data.name, category: data.category, business_id: businessId });
    setServices(ss => [...ss, data]);
    setNewSvc({ name: '', category: categoryOptions[0][0], price: '' });
    setAddingService(false);
  }

  async function uploadGalleryImage(file) {
    if (!file) return;
    setImgError('');
    if (!file.type.startsWith('image/')) { setImgError('Only image files are allowed'); return; }
    setAddingImg(true);
    const ext = file.name.split('.').pop();
    const path = `${businessId}/${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage.from('gallery').upload(path, file, { cacheControl: '3600', upsert: false });
    if (uploadError) { setImgError('Upload failed. Please try again.'); setAddingImg(false); return; }
    const { data: { publicUrl } } = supabase.storage.from('gallery').getPublicUrl(path);
    const { data, error } = await supabase.from('gallery').insert({ business_id: businessId, image_url: publicUrl, caption: imgCaption.trim() || null }).select().single();
    setAddingImg(false);
    if (error) { setImgError('Could not save image'); return; }
    track('gallery_uploaded', { business_id: businessId });
    setGallery(gs => [data, ...gs]);
    setImgCaption('');
  }
  async function removeImage(id) { setGallery(gs => gs.filter(g => g.id !== id)); await supabase.from('gallery').delete().eq('id', id); }

  async function uploadAvatar(file) {
    if (!file) return;
    setAvatarError('');
    if (!file.type.startsWith('image/')) { setAvatarError('Only image files are allowed'); return; }
    setAvatarUploading(true);
    try {
      const publicUrl = await uploadBusinessAvatar(businessId, file);
      track('avatar_uploaded', { business_id: businessId });
      setAvatarUrl(publicUrl);
    } catch {
      setAvatarError('Upload failed. Please try again.');
    } finally {
      setAvatarUploading(false);
    }
  }

  async function saveSettings() {
    setSettingsError(''); setSettingsSuccess(false);
    if (!settings.name.trim()) { setSettingsError('Business name is required'); return; }
    setSettingsSaving(true);
    const trimmed = { name: settings.name.trim(), owner_name: settings.owner_name.trim(), tagline: settings.tagline.trim(), whatsapp: settings.whatsapp.trim() };
    const { error } = await supabase.from('businesses').update(trimmed).eq('id', businessId);
    setSettingsSaving(false);
    if (error) { setSettingsError('Failed to save changes. Please try again.'); }
    else {
      setSettings(trimmed);
      setSavedSettings(trimmed);
      setSettingsSuccess(true);
      setTimeout(() => setSettingsSuccess(false), 3500);
    }
  }

  // The button itself carries the confirmation (it's the one thing the
  // user is guaranteed to be looking at right after the click); this is
  // a belt-and-braces nudge in case the card sits partly off-screen.
  useEffect(() => {
    if ((settingsSuccess || settingsError) && settingsButtonRef.current) {
      settingsButtonRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [settingsSuccess, settingsError]);

  function handleLogoutClick() {
    if (isSettingsDirty && !window.confirm('You have unsaved changes to your settings. Log out anyway?')) return;
    onLogout();
  }

  function fmtDate(s) {
    if (!s) return '—';
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtMoney(n) { return '₦' + (n || 0).toLocaleString(); }

  const priceColor = ['nail_studio','lash_studio','spa','barbershop','mua','other'].includes(businessType)
    ? 'text-beauty-primary' : 'text-sabi-gold';

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-sabi-dark font-sans">

      {/* ── Payment pending — the popup closed without confirming success,
          which happens routinely for a bank transfer completed outside
          the popup. Neutral wording on purpose: there's no way to tell
          "abandoned" from "gone to their banking app" from here, and the
          background poll will pick up the real state once the webhook
          activates it either way. ── */}
      {paymentPending && !activationError && (
        <div className="fixed top-0 left-0 right-0 z-[400] bg-sabi-gold/95 border-b border-sabi-gold px-4 py-3 sm:px-5">
          <div className="max-w-2xl mx-auto flex items-start gap-2">
            <Loader2 size={16} className="od-spin text-sabi-dark flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-sabi-dark font-bold">Waiting for your payment to complete</p>
              <p className="text-xs text-sabi-dark/80 mt-1 leading-relaxed">
                If you made a bank transfer, this can take a few minutes — we&rsquo;ll activate your account automatically the moment it&rsquo;s confirmed. No need to stay on this page.
              </p>
            </div>
            <button onClick={stopPendingCheck} className="text-sabi-dark/60 hover:text-sabi-dark bg-transparent border-0 cursor-pointer flex-shrink-0" aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* ── Payment verification failure — fixed, above the expired-plan
          overlay too, since this can happen during first activation. ── */}
      {activationError && (
        <div className="fixed top-0 left-0 right-0 z-[400] bg-red-500/95 border-b border-red-400 px-4 py-3 sm:px-5">
          <div className="max-w-2xl mx-auto flex flex-col gap-3">
            <div className="flex items-start gap-2">
              <AlertCircle size={16} className="text-white flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white font-bold">Payment received, activation failed</p>
                <p className="text-xs text-white/90 mt-1 leading-relaxed">
                  Paystack confirmed your payment, but we couldn&rsquo;t activate your account automatically.
                  Message us on WhatsApp with the reference below and we&rsquo;ll activate it manually — you have not been charged again.
                </p>
              </div>
              <button onClick={() => setActivationError(null)} className="text-white/70 hover:text-white bg-transparent border-0 cursor-pointer flex-shrink-0" aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
            <div className="flex items-center gap-2 bg-sabi-dark border border-white/20 rounded-lg pl-3 pr-1.5 py-1.5 max-w-sm">
              <input
                ref={activationRefRef}
                readOnly
                value={activationError.reference}
                onFocus={e => e.target.select()}
                className="flex-1 min-w-0 bg-transparent border-0 outline-none text-white text-xs font-mono py-1"
              />
              <button
                className="flex-shrink-0 flex items-center gap-1 text-xs font-bold px-2.5 py-1.5 rounded-md border-0 cursor-pointer bg-white/15 text-white hover:bg-white/25 transition-colors"
                onClick={() => copyActivationRef(activationError.reference, activationRefRef)}
              >
                {activationRefCopied ? <Check size={11} /> : <Copy size={11} />}
              </button>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <a
                href={`https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(buildActivationSupportMessage(settings.name, activationError.reference))}`}
                target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 bg-[#25D366] text-white text-xs font-bold px-4 py-2 rounded-lg no-underline"
              >
                <MessageCircle size={12} /> Message Support on WhatsApp
              </a>
              <button
                className="flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg border border-white/30 text-white bg-transparent cursor-pointer disabled:opacity-60 transition-opacity"
                onClick={() => verifyPayment(activationError.reference)}
                disabled={renewalLoading}
              >
                {renewalLoading && <Loader2 size={12} className="od-spin" />} Try Again
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Subscription overlay (activate for new / renew for expired) ── */}
      {showExpiredOverlay && (
        <SubscriptionOverlay mode={overlayMode} loading={renewalLoading} onPay={handleRenew} />
      )}

      {/* ── Expiring-soon renewal banner ─────────────────────── */}
      {showRenewalBanner && (
        <div className="bg-sabi-gold px-5 py-3 flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm font-medium text-sabi-dark">
            ⚠️ Your Danda plan expires in <strong>{daysLeft} day{daysLeft !== 1 ? 's' : ''}</strong> — Renew now to keep your booking page live.
          </p>
          <button className="bg-sabi-dark text-sabi-gold text-xs font-bold px-4 py-1.5 rounded border-0 cursor-pointer whitespace-nowrap" onClick={handleRenew} disabled={renewalLoading}>
            {renewalLoading ? 'Opening…' : 'Renew Now'}
          </button>
        </div>
      )}

      {/* ── Header ───────────────────────────────────────────── */}
      <header className="bg-sabi-card border-b border-sabi-border px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <button className="bg-transparent border-0 cursor-pointer p-0" onClick={() => { window.location.href = '/'; }}>
            <SabiLogo size="md" />
          </button>
          <button className="flex items-center gap-1.5 text-sabi-muted text-sm hover:text-white transition-colors bg-transparent border-0 cursor-pointer" onClick={handleLogoutClick}>
            <LogOut size={15} strokeWidth={1.75} />
            Log out
          </button>
        </div>

        {/* Tab bar */}
        <div className="max-w-4xl mx-auto flex overflow-x-auto gap-1 mt-4 pb-0.5" style={{ scrollbarWidth: 'none' }}>
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap border-0 cursor-pointer transition-colors flex-shrink-0 ${activeTab === id ? 'bg-sabi-gold text-sabi-dark' : 'text-sabi-muted hover:text-white'}`}
              onClick={() => setActiveTab(id)}
            >
              <Icon size={14} strokeWidth={1.75} />
              {label}
            </button>
          ))}
        </div>
      </header>

      {/* ── Main content ─────────────────────────────────────── */}
      <main className="max-w-4xl mx-auto px-4 py-6">

        {/* ── BOOKINGS ─────────────────────────────────────────── */}
        {activeTab === 'bookings' && (
          <div className="flex flex-col gap-6">

            {/* Booking link — permanent, always visible */}
            {bookingLink && (
              <div className="bg-sabi-card border border-sabi-border rounded-2xl p-5 flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <Link2 size={16} className="text-sabi-gold flex-shrink-0" />
                  <p className="text-sm font-semibold text-white">Your Booking Link</p>
                </div>
                <p className="text-xs text-sabi-muted">Share this so clients can book you directly</p>
                <div className="flex items-center gap-2 bg-sabi-dark border border-sabi-border rounded-lg pl-3 pr-1.5 py-1.5">
                  <input
                    ref={bookingLinkRef}
                    readOnly
                    value={bookingLink}
                    onFocus={e => e.target.select()}
                    className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sabi-green text-sm py-1"
                  />
                  <button
                    className="flex-shrink-0 flex items-center gap-1 text-xs font-bold px-3 py-2 rounded-lg border-0 cursor-pointer bg-sabi-gold text-sabi-dark hover:opacity-90 transition-opacity"
                    onClick={() => copyBookingLink(bookingLink, bookingLinkRef)}
                  >
                    {linkCopied ? <><Check size={12} strokeWidth={2.5} /> Copied!</> : <><Copy size={12} /> Copy</>}
                  </button>
                </div>
                <button
                  className="flex items-center justify-center gap-1.5 text-xs font-bold px-3 py-2.5 rounded-lg cursor-pointer bg-[#25D366]/10 text-[#25D366] border border-[#25D366]/20 hover:bg-[#25D366]/20 transition-colors"
                  onClick={() => {
                    const message = buildShareMessage(settings.name, settings.owner_name, businessType, bookingLink);
                    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
                  }}
                >
                  <MessageCircle size={13} /> Share on WhatsApp
                </button>
              </div>
            )}

            {/* Profile photo card */}
            <div className="bg-sabi-card border border-sabi-border rounded-2xl p-5 flex items-center gap-4">
              <div className="relative w-14 h-14 rounded-xl overflow-hidden bg-sabi-dark flex items-center justify-center flex-shrink-0">
                {avatarUrl
                  ? <img src={avatarUrl} alt="Profile" className="w-full h-full object-cover" />
                  : <User size={28} strokeWidth={1.25} className="text-sabi-muted" />
                }
                {avatarUploading && (
                  <div className="absolute inset-0 bg-sabi-dark/80 flex items-center justify-center">
                    <Loader2 size={18} className="od-spin text-sabi-green" />
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-xs text-sabi-muted font-semibold uppercase tracking-wider">Profile Photo</p>
                <label className={`text-sm font-semibold cursor-pointer px-4 py-1.5 rounded-lg border border-sabi-border text-sabi-muted hover:text-white hover:border-sabi-green transition-colors ${avatarUploading ? 'opacity-50 cursor-not-allowed' : ''}`}>
                  {avatarUploading ? 'Uploading…' : 'Upload Photo'}
                  <input type="file" accept="image/*" className="hidden" disabled={avatarUploading} onChange={e => uploadAvatar(e.target.files[0])} />
                </label>
                {avatarError && <p className="text-xs text-red-400">{avatarError}</p>}
              </div>
            </div>

            {/* Earnings cards */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-sabi-card border border-sabi-border rounded-2xl p-5">
                <p className="text-xs uppercase tracking-widest text-sabi-green mb-2 font-bold">Today&rsquo;s Earnings</p>
                <p className={`text-3xl font-black ${priceColor}`}>{fmtMoney(todayEarnings)}</p>
                <p className="text-xs text-sabi-muted mt-1">{todayBookings.filter(b => b.status === 'confirmed').length} confirmed today</p>
              </div>
              <div className="bg-sabi-card border border-sabi-gold/20 rounded-2xl p-5">
                <p className="text-xs uppercase tracking-widest text-sabi-green mb-2 font-bold">Monthly Earnings</p>
                <p className={`text-3xl font-black ${priceColor}`}>{fmtMoney(monthlyEarnings)}</p>
                <p className="text-xs text-sabi-muted mt-1">{confirmed.filter(b => typeof b.date === 'string' && b.date.startsWith(currentMonth)).length} confirmed this month</p>
              </div>
            </div>

            {/* Earnings summary — collapsible */}
            <div className="bg-sabi-card border border-sabi-border rounded-2xl overflow-hidden">
              <button className="w-full flex items-center justify-between px-5 py-4 text-left bg-transparent border-0 cursor-pointer" onClick={() => setShowEarningsHistory(v => !v)}>
                <span className="font-semibold text-white">Earnings Summary</span>
                <ChevronDown size={14} className={`text-sabi-muted transition-transform ${showEarningsHistory ? 'rotate-180' : ''}`} />
              </button>
              {showEarningsHistory && (
                <div className="border-t border-sabi-border px-5 pb-5 pt-4">
                  <div className="flex items-center justify-between mb-3 pb-3 border-b border-sabi-border">
                    <span className="text-xs text-sabi-muted uppercase tracking-wider">Lifetime Earnings</span>
                    <span className="font-black text-sabi-gold">{fmtMoney(lifetimeEarnings)}</span>
                  </div>
                  {earningsByMonth.map(({ prefix, label, total }) => (
                    <div key={prefix} className={`flex items-center justify-between py-2 ${prefix === currentMonth ? 'text-white' : 'text-sabi-muted'}`}>
                      <span className="text-sm">{label}</span>
                      <span className="text-sm font-semibold">{fmtMoney(total)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Tomorrow's bookings — the primary night-before worklist */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="font-semibold text-white">Tomorrow</h3>
                {tomorrowBookings.length > 0 && <span className="bg-sabi-gold text-sabi-dark text-xs font-black px-2 py-0.5 rounded-full">{tomorrowBookings.length}</span>}
              </div>
              {bookingsLoading ? <SkeletonList count={2} /> : tomorrowBookings.length === 0
                ? <EmptyState icon={<Moon size={28} strokeWidth={1} />} text="Nothing booked for tomorrow yet — enjoy the quiet." />
                : <div className="flex flex-col gap-3">{tomorrowBookings.map(b => <BookingCard key={b.id} booking={b} onStatus={setBookingStatus} onDelete={removeBooking} onRemind={markReminderSent} fmtDate={fmtDate} bizSlug={bizSlug} businessName={settings.name} />)}</div>
              }
            </div>

            {/* Today's bookings */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="font-semibold text-white">Today</h3>
                {todayBookings.length > 0 && <span className="bg-sabi-gold text-sabi-dark text-xs font-black px-2 py-0.5 rounded-full">{todayBookings.length}</span>}
              </div>
              {bookingsLoading ? <SkeletonList count={2} /> : todayBookings.length === 0
                ? <EmptyState icon={<Calendar size={28} strokeWidth={1} />} text="No appointments today" />
                : <div className="flex flex-col gap-3">{todayBookings.map(b => <BookingCard key={b.id} booking={b} onStatus={setBookingStatus} onDelete={removeBooking} onRemind={markReminderSent} fmtDate={fmtDate} bizSlug={bizSlug} businessName={settings.name} />)}</div>
              }
            </div>

            {/* All bookings */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="font-semibold text-white">All Bookings</h3>
                {bookings.length > 0 && <span className="bg-sabi-card border border-sabi-border text-sabi-muted text-xs font-bold px-2 py-0.5 rounded-full">{bookings.length}</span>}
              </div>
              {bookingsLoading ? <SkeletonList count={4} /> : bookings.length === 0
                ? <EmptyState icon={<Calendar size={28} strokeWidth={1} />} text="No bookings yet" />
                : <div className="flex flex-col gap-3">{bookings.map(b => <BookingCard key={b.id} booking={b} onStatus={setBookingStatus} onDelete={removeBooking} onRemind={markReminderSent} fmtDate={fmtDate} bizSlug={bizSlug} businessName={settings.name} />)}</div>
              }
            </div>
          </div>
        )}

        {/* ── SERVICES ─────────────────────────────────────────── */}
        {activeTab === 'services' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-white text-lg">Services</h3>
              {!addingService && (
                <button className="flex items-center gap-1.5 bg-sabi-gold text-sabi-dark text-xs font-black px-3 py-1.5 rounded-lg border-0 cursor-pointer" onClick={() => { setAddingService(true); setSvcError(''); }}>
                  <Plus size={13} /> Add Service
                </button>
              )}
            </div>

            {addingService && (
              <div className="bg-sabi-card border border-sabi-border rounded-xl p-4 mb-4 flex flex-col gap-3">
                <input className={inputCls} placeholder="Service name" value={newSvc.name} autoFocus onChange={e => { setNewSvc(n => ({ ...n, name: e.target.value })); setSvcError(''); }} />
                <select className={selectCls} value={newSvc.category} onChange={e => setNewSvc(n => ({ ...n, category: e.target.value }))}>
                  {categoryOptions.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
                </select>
                <input className={inputCls} placeholder="Price (₦)" type="number" min="0" value={newSvc.price} onChange={e => { setNewSvc(n => ({ ...n, price: e.target.value })); setSvcError(''); }} />
                <div className="flex items-center gap-2 flex-wrap">
                  {svcError && <span className="text-red-400 text-xs flex-1">{svcError}</span>}
                  <button className="bg-sabi-gold text-sabi-dark text-xs font-black px-4 py-1.5 rounded-lg border-0 cursor-pointer" onClick={submitNewService}>Save</button>
                  <button className="text-sabi-muted text-xs font-semibold px-4 py-1.5 rounded-lg border border-sabi-border bg-transparent cursor-pointer hover:text-white transition-colors" onClick={() => { setAddingService(false); setSvcError(''); setNewSvc({ name: '', category: categoryOptions[0][0], price: '' }); }}>Cancel</button>
                </div>
              </div>
            )}

            {servicesLoading ? <SkeletonList count={7} height={48} /> : (
              <div className="bg-sabi-card border border-sabi-border rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead className="bg-sabi-deep">
                      <tr>
                        {['Service', 'Category', 'Price', 'Active', ''].map((h, i) => (
                          <th key={i} className={`px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-sabi-muted ${i === 4 ? 'text-right' : ''}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {services.map(svc => {
                        const isEditing = editingId === svc.id;
                        return (
                          <tr key={svc.id} className="border-t border-sabi-border/50 hover:bg-sabi-deep/30 transition-colors">
                            <td className="px-4 py-3">
                              {isEditing
                                ? <input className={`${inputCls} text-xs`} value={editDraft.name} autoFocus onChange={e => setEditDraft(d => ({ ...d, name: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') saveEdit(svc.id); if (e.key === 'Escape') setEditingId(null); }} />
                                : <span className="text-white font-medium">{svc.name}</span>
                              }
                            </td>
                            <td className="px-4 py-3">
                              {isEditing
                                ? <select className={`${selectCls} text-xs`} value={editDraft.category} onChange={e => setEditDraft(d => ({ ...d, category: e.target.value }))}>{categoryOptions.map(([val, label]) => <option key={val} value={val}>{label}</option>)}</select>
                                : <span className="text-xs bg-sabi-dark border border-sabi-border rounded px-2 py-0.5 text-sabi-muted capitalize">{svc.category}</span>
                              }
                            </td>
                            <td className="px-4 py-3">
                              {isEditing
                                ? <input className={`${inputCls} text-xs w-24`} type="number" min="0" value={editDraft.price} onChange={e => setEditDraft(d => ({ ...d, price: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') saveEdit(svc.id); if (e.key === 'Escape') setEditingId(null); }} />
                                : <span className="text-sabi-gold font-semibold">₦{(svc.price || 0).toLocaleString()}</span>
                              }
                            </td>
                            <td className="px-4 py-3">
                              <button className={`od-toggle ${svc.active ? 'od-toggle--on' : ''}`} onClick={() => toggleActive(svc.id, svc.active)} title={svc.active ? 'Active' : 'Inactive'}>
                                <span className="od-toggle-knob" />
                              </button>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                {isEditing ? (
                                  <>
                                    <button className="w-7 h-7 rounded bg-sabi-green/20 text-sabi-green flex items-center justify-center hover:bg-sabi-green/30 border-0 cursor-pointer" onClick={() => saveEdit(svc.id)}><Check size={13} /></button>
                                    <button className="w-7 h-7 rounded bg-sabi-border/30 text-sabi-muted flex items-center justify-center hover:bg-sabi-border/50 border-0 cursor-pointer" onClick={() => setEditingId(null)}><X size={13} /></button>
                                  </>
                                ) : (
                                  <>
                                    <button className="w-7 h-7 rounded bg-sabi-border/20 text-sabi-muted flex items-center justify-center hover:text-white hover:bg-sabi-border/40 border-0 cursor-pointer" onClick={() => startEdit(svc)}><Pencil size={12} /></button>
                                    <button className="w-7 h-7 rounded bg-red-500/10 text-red-400 flex items-center justify-center hover:bg-red-500/20 border-0 cursor-pointer" onClick={() => removeService(svc.id)}><Trash2 size={12} /></button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {services.length === 0 && !servicesLoading && (
                        <tr><td colSpan={5} className="px-4 py-12 text-center text-sabi-muted text-sm">No services yet</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── CLIENTS ──────────────────────────────────────────── */}
        {activeTab === 'clients' && (
          <div>
            <div className="flex items-center gap-2 mb-4">
              <h3 className="font-semibold text-white text-lg">Clients</h3>
              {clients.length > 0 && <span className="bg-sabi-card border border-sabi-border text-sabi-muted text-xs font-bold px-2 py-0.5 rounded-full">{clients.length} total</span>}
            </div>
            {clientsLoading ? <SkeletonList count={5} height={68} /> : clients.length === 0
              ? <EmptyState icon={<Users size={28} strokeWidth={1} />} text="No clients yet" />
              : (
                <div className="flex flex-col gap-2">
                  {clients.map(c => (
                    <div key={c.id} className="bg-sabi-card border border-sabi-border rounded-xl flex items-center gap-3 p-4 hover:bg-sabi-deep/30 transition-colors">
                      <div className="w-10 h-10 rounded-full bg-sabi-dark border border-sabi-border flex items-center justify-center text-sm font-black text-sabi-green flex-shrink-0">
                        {c.initials || '?'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-white font-medium text-sm truncate">{c.name}</p>
                        <p className="text-sabi-muted text-xs truncate">{c.phone}</p>
                      </div>
                      <div className="text-right hidden sm:block">
                        <p className="text-white text-xs font-medium">{c.last_service || '—'}</p>
                        <p className="text-sabi-muted text-xs">{c.last_visit ? fmtDate(c.last_visit) : '—'}</p>
                      </div>
                      <div className="flex flex-col items-center flex-shrink-0">
                        <span className="text-sabi-gold font-black text-lg leading-none">{c.visit_count}</span>
                        <span className="text-sabi-muted text-xs">visits</span>
                      </div>
                    </div>
                  ))}
                </div>
              )
            }
          </div>
        )}

        {/* ── GALLERY ──────────────────────────────────────────── */}
        {activeTab === 'gallery' && (
          <div>
            <div className="flex items-center gap-2 mb-4">
              <h3 className="font-semibold text-white text-lg">Gallery</h3>
              {gallery.length > 0 && <span className="bg-sabi-card border border-sabi-border text-sabi-muted text-xs font-bold px-2 py-0.5 rounded-full">{gallery.length} images</span>}
            </div>
            <div className="flex gap-3 mb-4 flex-wrap">
              <label className={`flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-lg border border-sabi-border cursor-pointer transition-colors ${addingImg ? 'text-sabi-muted opacity-60' : 'text-sabi-muted hover:text-white hover:border-sabi-green'}`}>
                <Upload size={13} />
                {addingImg ? 'Uploading…' : 'Upload Image'}
                <input type="file" accept="image/*" className="hidden" disabled={addingImg} onChange={e => { setImgError(''); uploadGalleryImage(e.target.files[0]); e.target.value = ''; }} />
              </label>
              <input className={`${inputCls} flex-1 min-w-40`} placeholder="Caption (optional)" value={imgCaption} onChange={e => setImgCaption(e.target.value)} />
            </div>
            {imgError && <p className="text-red-400 text-xs mb-3">{imgError}</p>}

            {galleryLoading ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {Array.from({ length: 6 }).map((_, i) => <div key={i} className="rounded-xl bg-sabi-card animate-pulse" style={{ height: 150 }} />)}
              </div>
            ) : gallery.length === 0 ? (
              <EmptyState icon={<ImageIcon size={28} strokeWidth={1} />} text="No images yet" />
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {gallery.map(img => (
                  <div key={img.id} className="relative rounded-xl overflow-hidden group">
                    <img src={img.image_url} alt={img.caption || 'Gallery'} className="w-full object-cover" style={{ height: 150 }} loading="lazy" />
                    {img.caption && <p className="text-xs text-sabi-muted bg-sabi-dark/80 px-2 py-1 truncate">{img.caption}</p>}
                    <button
                      className="absolute top-2 right-2 w-7 h-7 rounded-lg bg-red-500/80 text-white flex items-center justify-center border-0 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => removeImage(img.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── SETTINGS ─────────────────────────────────────────── */}
        {activeTab === 'settings' && (
          <div>
            <h3 className="font-semibold text-white text-lg mb-4">Business Settings</h3>
            <div className="bg-sabi-card border border-sabi-border rounded-2xl p-5 flex flex-col gap-4">
              {[
                { label: 'Business Name', key: 'name', placeholder: "e.g. Chi's Nail Studio" },
                { label: 'Owner Full Name', key: 'owner_name', placeholder: 'Your full name' },
                { label: 'Tagline', key: 'tagline', placeholder: 'e.g. Nail Technician · Lagos, Nigeria', hint: 'Shown on your public booking page' },
                { label: 'WhatsApp Number', key: 'whatsapp', placeholder: 'e.g. 2348012345678', hint: 'Used to confirm bookings with clients' },
              ].map(({ label, key, placeholder, hint }) => (
                <div key={key}>
                  <label className="block text-xs font-semibold text-sabi-muted uppercase tracking-wider mb-1">{label}
                    {hint && <span className="ml-2 normal-case tracking-normal text-sabi-border">— {hint}</span>}
                  </label>
                  <input className={`${inputCls} w-full`} value={settings[key]} placeholder={placeholder} onChange={e => setSettings(s => ({ ...s, [key]: e.target.value }))} />
                </div>
              ))}

              {settingsError && <p className="text-red-400 text-sm">{settingsError}</p>}

              <button
                ref={settingsButtonRef}
                className={`font-bold py-3 rounded-xl border-0 cursor-pointer flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed transition-colors ${settingsSuccess ? 'bg-sabi-green text-white' : 'bg-sabi-gold text-sabi-dark'}`}
                onClick={saveSettings}
                disabled={settingsSaving || !isSettingsDirty}
              >
                {settingsSaving
                  ? <><Loader2 size={14} className="od-spin" /> Saving…</>
                  : settingsSuccess
                    ? <><Check size={16} strokeWidth={2.5} /> Saved</>
                    : 'Save Changes'}
              </button>
              {settingsSuccess && (
                <p className="flex items-center gap-1.5 text-sabi-green text-sm -mt-2">
                  <Check size={13} strokeWidth={2.5} /> Changes saved successfully
                </p>
              )}
            </div>
            <PayoutSetup businessId={businessId} payout={payout} onSaved={setPayout} />
          </div>
        )}

      </main>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SubscriptionOverlay({ mode, loading, onPay }) {
  const isActivate = mode === 'activate';
  return (
    <div className="fixed inset-0 z-[300] bg-sabi-dark/97 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-sabi-card border border-sabi-border rounded-2xl p-8 flex flex-col items-center gap-0">
        <button onClick={() => { window.location.href = '/'; }} className="bg-transparent border-0 cursor-pointer p-0">
          <SabiLogo size="md" />
        </button>
        <h2 className="font-serif text-2xl font-medium text-white text-center mt-5 mb-2.5">
          {isActivate ? 'Activate Your Danda Account' : 'Your Danda plan has expired'}
        </h2>
        <p className="text-sm text-sabi-muted text-center mb-6 leading-relaxed">
          {isActivate
            ? 'One plan. Everything included. Cancel any time.'
            : 'Renew now to reactivate your booking page and continue accepting bookings.'}
        </p>
        <div className="w-full bg-sabi-dark border border-sabi-border/15 rounded-xl p-5 mb-5">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-xs text-sabi-muted line-through">₦{PRICING.fullPrice.toLocaleString()}/yr</span>
            <span className="font-serif text-4xl font-semibold text-sabi-gold">
              ₦{PRICING.promoPrice.toLocaleString()}<span className="font-sans text-sm text-sabi-muted font-normal">/yr</span>
            </span>
          </div>
          <p className="text-xs text-sabi-muted">{PRICING.promoNote}</p>
        </div>
        <button
          className="w-full bg-sabi-gold text-sabi-dark font-bold py-3.5 rounded-xl border-0 cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed"
          onClick={onPay}
          disabled={loading}
        >
          {loading
            ? 'Opening payment…'
            : isActivate
              ? `Pay ₦${PRICING.promoPrice.toLocaleString()} — Activate Now`
              : `Renew for ₦${PRICING.promoPrice.toLocaleString()}`}
        </button>
      </div>
    </div>
  );
}

function SkeletonList({ count = 4, height = 80 }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl bg-sabi-card animate-pulse" style={{ height }} />
      ))}
    </div>
  );
}

function EmptyState({ icon, text }) {
  return (
    <div className="flex flex-col items-center py-14 gap-3">
      <span className="text-sabi-muted">{icon}</span>
      <p className="text-sabi-muted text-sm">{text}</p>
    </div>
  );
}

const STATUS_STYLES = {
  confirmed: 'bg-sabi-green/10 text-sabi-green border-sabi-green/20',
  pending:   'bg-sabi-gold/10 text-sabi-gold border-sabi-gold/20',
  cancelled: 'bg-red-500/10 text-red-400 border-red-500/20',
};

function BookingCard({ booking, onStatus, onDelete, onRemind, fmtDate, bizSlug, businessName }) {
  const { id, client_name, client_phone, service_name, price, date, time, ampm, status, notes, reminder_sent_at } = booking;
  const { copied: ratingCopied, copy: copyRating } = useCopyToClipboard();

  const waPhone = normalizeNgPhone(client_phone);
  const phoneInvalid = !waPhone;

  function copyRatingLink() {
    if (!bizSlug) return;
    copyRating(`${window.location.origin}/${bizSlug}?rate=${id}`);
  }

  function confirmBooking() {
    const waUrl = buildClientWhatsAppUrl(client_phone, 'confirmed', booking);
    if (waUrl) window.open(waUrl, '_blank', 'noopener,noreferrer');
    onStatus(id, 'confirmed');
  }

  function cancelBooking() {
    const waUrl = buildClientWhatsAppUrl(client_phone, 'cancelled', booking);
    if (waUrl) window.open(waUrl, '_blank', 'noopener,noreferrer');
    onStatus(id, 'cancelled');
  }

  function sendReminder(channel) {
    if (phoneInvalid) return;
    const message = reminderMessage(booking, { name: businessName });
    const url = channel === 'whatsapp'
      ? `https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`
      : `sms:${waPhone}?body=${encodeURIComponent(message)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    onRemind(id);
  }

  return (
    <div className={`bg-sabi-card border rounded-xl p-4 ${status === 'confirmed' ? 'border-sabi-green/20' : status === 'cancelled' ? 'border-red-500/10' : 'border-sabi-border'}`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <p className="font-semibold text-white text-sm">{client_name}</p>
          <p className="text-sabi-muted text-xs">{client_phone}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${STATUS_STYLES[status] ?? 'bg-sabi-border/20 text-sabi-muted border-sabi-border/30'}`}>
            {status}
          </span>
          {reminder_sent_at && (
            <span className="flex items-center gap-0.5 text-sabi-green text-[11px] font-semibold">
              <Check size={10} strokeWidth={2.5} /> Reminded
            </span>
          )}
        </div>
      </div>
      <p className="text-sm text-sabi-muted mb-1">
        <span className="text-white font-medium">{service_name}</span>
        {' · '}₦{(price || 0).toLocaleString()}
        {' · '}{fmtDate(date)}{time ? ` · ${time} ${ampm}` : ''}
      </p>
      {notes && <p className="text-xs text-sabi-muted bg-sabi-dark rounded px-3 py-2 mt-2 mb-2">{notes}</p>}
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        {status === 'pending' && (
          <button className="flex items-center gap-1 bg-sabi-green/15 text-sabi-green text-xs font-bold px-3 py-1.5 rounded-lg border border-sabi-green/20 cursor-pointer hover:bg-sabi-green/25 transition-colors" onClick={confirmBooking}>
            <Check size={11} /> Confirm
          </button>
        )}
        {status !== 'cancelled' && (
          <button className="flex items-center gap-1 bg-red-500/10 text-red-400 text-xs font-bold px-3 py-1.5 rounded-lg border border-red-500/20 cursor-pointer hover:bg-red-500/20 transition-colors" onClick={cancelBooking}>
            <X size={11} /> Cancel
          </button>
        )}
        {status === 'cancelled' && (
          <button className="text-sabi-muted text-xs font-semibold px-3 py-1.5 rounded-lg border border-sabi-border bg-transparent cursor-pointer hover:text-white transition-colors" onClick={() => onStatus(id, 'pending')}>
            Restore
          </button>
        )}
        {status === 'confirmed' && bizSlug && (
          <button
            className="flex items-center gap-1 bg-sabi-gold/10 text-sabi-gold text-xs font-bold px-3 py-1.5 rounded-lg border border-sabi-gold/20 cursor-pointer hover:bg-sabi-gold/20 transition-colors"
            onClick={copyRatingLink}
            aria-label="Copy rating request link">
            {ratingCopied ? <><Check size={11} /> Copied!</> : <><Star size={11} /> Request rating</>}
          </button>
        )}
        <button
          className={`flex items-center gap-1 bg-[#25D366]/10 text-[#25D366] text-xs font-bold px-3 py-1.5 rounded-lg border border-[#25D366]/20 transition-colors ${phoneInvalid ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-[#25D366]/20'}`}
          disabled={phoneInvalid}
          title={phoneInvalid ? 'This phone number looks invalid — check it before sending' : undefined}
          onClick={() => sendReminder('whatsapp')}
          aria-label="Remind client on WhatsApp">
          <MessageCircle size={11} /> Remind on WhatsApp
        </button>
        <button
          className={`flex items-center gap-1 bg-sabi-border/20 text-sabi-muted text-xs font-bold px-3 py-1.5 rounded-lg border border-sabi-border transition-colors ${phoneInvalid ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:text-white hover:bg-sabi-border/40'}`}
          disabled={phoneInvalid}
          title={phoneInvalid ? 'This phone number looks invalid — check it before sending' : undefined}
          onClick={() => sendReminder('sms')}
          aria-label="Remind client by SMS">
          <Smartphone size={11} /> Remind by SMS
        </button>
        <button className="flex items-center gap-1 bg-red-500/5 text-red-400/70 text-xs font-bold px-3 py-1.5 rounded-lg border border-red-500/10 cursor-pointer hover:bg-red-500/15 transition-colors ml-auto" onClick={() => onDelete(id)}>
          <Trash2 size={11} /> Delete
        </button>
      </div>
    </div>
  );
}
