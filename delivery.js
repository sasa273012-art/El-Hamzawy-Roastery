const SUPABASE_URL = 'https://odwmymujroxztatmkxav.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_BtiZVBJ6puj_gOddR-Adsg_Xqr3Kxox';
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const $ = id => document.getElementById(id);
const state = { orders: [], refreshTimer: null, actionPending: false };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function money(value) {
  return `${Number(value || 0).toLocaleString('ar-EG', { maximumFractionDigits: 2 })} جنيه`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function showScreen(name) {
  $('login-screen').hidden = name !== 'login';
  $('access-screen').hidden = name !== 'access';
  $('dashboard').hidden = name !== 'dashboard';
  $('sign-out').hidden = name === 'login';
}

function setMessage(id, message) {
  $(id).textContent = message;
}

async function signOut() {
  clearInterval(state.refreshTimer);
  await supabaseClient.auth.signOut();
  state.orders = [];
  showScreen('login');
}

async function openDashboard(session) {
  const { data: courier, error } = await supabaseClient
    .from('store_delivery_staff')
    .select('user_id')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (error) {
    showScreen('login');
    setMessage('login-message', 'تعذر التحقق من الحساب. تأكد من إعداد صلاحيات المندوبين في Supabase.');
    return;
  }
  if (!courier) {
    showScreen('access');
    return;
  }

  $('account-label').textContent = session.user.email || '';
  showScreen('dashboard');
  await loadOrders();
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(loadOrders, 15000);
}

function orderCard(order, assigned) {
  const items = Array.isArray(order.items) ? order.items : [];
  const phone = String(order.phone || '').replace(/[^0-9+]/g, '');
  const hasDeliveryLocation = order.delivery_latitude != null && order.delivery_longitude != null
    && Number.isFinite(Number(order.delivery_latitude)) && Number.isFinite(Number(order.delivery_longitude));
  const deliveryMapUrl = hasDeliveryLocation
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${order.delivery_latitude},${order.delivery_longitude}`)}`
    : '';
  const deliveryDistance = order.delivery_distance_km == null
    ? ''
    : ` (${Number(order.delivery_distance_km).toLocaleString('ar-EG', { maximumFractionDigits: 4 })} كم)`;
  const payment = order.payment_method === 'cash' ? 'الدفع عند الاستلام' : 'تم تأكيد الدفع إلكترونيًا';
  return `
    <article class="delivery-card">
      <div class="delivery-card-head"><strong dir="ltr">${escapeHtml(order.code)}</strong><time>${escapeHtml(formatDate(order.created_at))}</time></div>
      <div class="delivery-card-body">
        <div class="delivery-customer"><div><strong>${escapeHtml(order.customer)}</strong><a class="delivery-phone" href="tel:${escapeHtml(phone)}">${escapeHtml(order.phone)}</a></div><span class="status-badge">${payment}</span></div>
        <div class="delivery-address">${escapeHtml(order.address)}</div>
        ${deliveryMapUrl ? `<div class="delivery-address"><a href="${escapeHtml(deliveryMapUrl)}" target="_blank" rel="noopener">فتح موقع العميل على الخريطة</a></div>` : ''}
        ${order.notes ? `<div class="delivery-address">ملاحظة: ${escapeHtml(order.notes)}</div>` : ''}
        <div class="delivery-items"><strong>محتويات الطلب</strong>${items.map(item => `<div class="delivery-item"><span>${escapeHtml(item.name)} — ${escapeHtml(item.weight || `${item.weightGrams || ''} جم`)} × ${escapeHtml(item.quantity)}</span><strong>${escapeHtml(money(item.subtotal))}</strong></div>`).join('')}</div>
        <div class="delivery-total"><span>تكلفة التوصيل${escapeHtml(deliveryDistance)}</span><strong>${escapeHtml(money(order.delivery_fee))}</strong></div>
        <div class="delivery-total"><span>${order.payment_method === 'cash' ? 'المطلوب تحصيله' : 'إجمالي الطلب'}</span><strong>${escapeHtml(money(order.total))}</strong></div>
      </div>
      <div class="delivery-card-actions"><button class="primary-button" type="button" data-action="${assigned ? 'complete' : 'claim'}" data-order-id="${escapeHtml(order.id)}" ${state.actionPending ? 'disabled' : ''}>${assigned ? 'تأكيد توصيل الطلب' : 'استلام للتوصيل'}</button></div>
    </article>`;
}

function renderOrders() {
  const available = state.orders.filter(order => order.delivery_status === 'متاح');
  const assigned = state.orders.filter(order => order.delivery_status === 'مع المندوب');
  $('count-available').textContent = available.length.toLocaleString('ar-EG');
  $('count-assigned').textContent = assigned.length.toLocaleString('ar-EG');
  $('available-label').textContent = `${available.length.toLocaleString('ar-EG')} طلب`;
  $('assigned-label').textContent = `${assigned.length.toLocaleString('ar-EG')} طلب`;
  $('available-orders').innerHTML = available.length ? available.map(order => orderCard(order, false)).join('') : '<div class="delivery-empty">لا توجد طلبات جاهزة للاستلام.</div>';
  $('assigned-orders').innerHTML = assigned.length ? assigned.map(order => orderCard(order, true)).join('') : '<div class="delivery-empty">لا توجد طلبات معك حاليًا.</div>';
}

async function loadOrders() {
  const { data, error } = await supabaseClient.rpc('list_store_delivery_orders');
  if (error) {
    setMessage('dashboard-message', `تعذر تحميل الطلبات: ${error.message}`);
    return;
  }
  setMessage('dashboard-message', '');
  state.orders = data || [];
  renderOrders();
}

async function handleOrderAction(button) {
  if (state.actionPending) return;
  state.actionPending = true;
  const orderId = button.dataset.orderId;
  const functionName = button.dataset.action === 'claim' ? 'claim_store_delivery_order' : 'complete_store_delivery_order';
  button.disabled = true;
  setMessage('dashboard-message', button.dataset.action === 'claim' ? 'جارٍ استلام الطلب...' : 'جارٍ تأكيد التوصيل...');
  const { data, error } = await supabaseClient.rpc(functionName, { p_order_id: orderId });
  state.actionPending = false;

  if (error || !data) {
    setMessage('dashboard-message', error ? `تعذر تنفيذ العملية: ${error.message}` : 'الطلب استلمه مندوب آخر أو لم يعد متاحًا. حدّث القائمة.');
    await loadOrders();
    return;
  }

  setMessage('dashboard-message', button.dataset.action === 'claim' ? 'تم استلام الطلب وأصبح ظاهرًا ضمن طلباتك.' : 'تم تأكيد توصيل الطلب بنجاح.');
  await loadOrders();
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('login-form').querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage('login-message', 'جارٍ تسجيل الدخول...');
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
  button.disabled = false;
  if (error) {
    setMessage('login-message', 'تعذر تسجيل الدخول. راجع البريد وكلمة المرور.');
    return;
  }
  $('password').value = '';
  await openDashboard(data.session);
});

$('sign-out').addEventListener('click', signOut);
$('access-sign-out').addEventListener('click', signOut);
$('refresh-orders').addEventListener('click', loadOrders);
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action][data-order-id]');
  if (button) handleOrderAction(button);
});

async function initialize() {
  if (!supabaseClient) {
    setMessage('login-message', 'تعذر تحميل مكتبة Supabase. تحقق من الاتصال بالإنترنت.');
    return;
  }
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) await openDashboard(session);
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    if (!session) showScreen('login');
  });
}

initialize();