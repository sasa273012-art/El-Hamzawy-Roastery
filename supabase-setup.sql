create table if not exists public.store_delivery_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.store_delivery_staff enable row level security;
revoke all on table public.store_delivery_staff from public, anon, authenticated;
grant select on table public.store_delivery_staff to authenticated;

drop policy if exists store_delivery_staff_read_self on public.store_delivery_staff;
create policy store_delivery_staff_read_self
  on public.store_delivery_staff
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create table if not exists public.store_orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  created_at timestamptz not null default now(),
  customer text not null check (char_length(trim(customer)) between 1 and 120),
  phone text not null check (char_length(phone) between 8 and 30),
  normalized_phone text not null check (normalized_phone ~ '^[0-9]{10,15}$'),
  address text not null check (char_length(trim(address)) between 1 and 1000),
  payment_method text not null check (payment_method in ('cash', 'wallet', 'instapay')),
  payment_recipient text not null default '',
  receipt_path text,
  notes text not null default '' check (char_length(notes) <= 2000),
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  subtotal numeric(10, 2) not null check (subtotal >= 0),
  coupon_code text,
  coupon_discount numeric(10, 2) not null default 0 check (coupon_discount >= 0),
  points_used integer not null default 0 check (points_used >= 0),
  discount numeric(10, 2) not null default 0 check (discount >= 0),
  delivery_fee numeric(10, 2) not null default 0 check (delivery_fee >= 0),
  delivery_distance_km numeric(10, 4),
  delivery_latitude numeric(9, 6),
  delivery_longitude numeric(9, 6),
  total numeric(10, 2) not null check (total >= 0),
  points_earned integer not null default 0 check (points_earned >= 0),
  status text not null check (status in ('طلب جديد', 'بانتظار تأكيد الدفع', 'تم تأكيد الدفع', 'تعذر تأكيد الدفع')),
  fulfillment_status text not null default 'قيد التجهيز',
  delivery_status text not null default 'غير جاهز',
  delivery_user_id uuid references public.store_delivery_staff(user_id),
  delivered_at timestamptz,
  constraint store_orders_payment_receipt_check check (
    (payment_method = 'cash' and receipt_path is null and status = 'طلب جديد')
    or
    (
      payment_method in ('wallet', 'instapay')
      and receipt_path is not null
      and status in ('بانتظار تأكيد الدفع', 'تم تأكيد الدفع', 'تعذر تأكيد الدفع')
    )
  )
);

alter table public.store_orders
  add column if not exists fulfillment_status text not null default 'قيد التجهيز';
alter table public.store_orders
  add column if not exists delivery_status text not null default 'غير جاهز';
alter table public.store_orders
  add column if not exists delivery_user_id uuid references public.store_delivery_staff(user_id);
alter table public.store_orders
  add column if not exists delivered_at timestamptz;
alter table public.store_orders
  add column if not exists delivery_fee numeric(10, 2) not null default 0;
alter table public.store_orders
  add column if not exists delivery_distance_km numeric(10, 4);
alter table public.store_orders
  add column if not exists delivery_latitude numeric(9, 6);
alter table public.store_orders
  add column if not exists delivery_longitude numeric(9, 6);
alter table public.store_orders
  drop constraint if exists store_orders_check;
alter table public.store_orders
  drop constraint if exists store_orders_total_check;
alter table public.store_orders
  add constraint store_orders_total_check
  check (total >= 0 and total = greatest(0, subtotal - discount) + delivery_fee);
alter table public.store_orders
  drop constraint if exists store_orders_delivery_location_check;
alter table public.store_orders
  add constraint store_orders_delivery_location_check
  check (
    (
      delivery_latitude is null
      and delivery_longitude is null
      and delivery_distance_km is null
      and delivery_fee = 0
    )
    or
    (
      delivery_latitude is not null
      and delivery_longitude is not null
      and delivery_distance_km is not null
      and delivery_latitude between -90 and 90
      and delivery_longitude between -180 and 180
      and delivery_distance_km >= 0
      and delivery_fee = round(delivery_distance_km * 8, 2)
    )
  );
alter table public.store_orders
  drop constraint if exists store_orders_fulfillment_status_check;
alter table public.store_orders
  add constraint store_orders_fulfillment_status_check
  check (fulfillment_status in ('قيد التجهيز', 'مكتمل'));
alter table public.store_orders
  drop constraint if exists store_orders_delivery_status_check;
alter table public.store_orders
  add constraint store_orders_delivery_status_check
  check (delivery_status in ('غير جاهز', 'متاح', 'مع المندوب', 'تم التوصيل'));

update public.store_orders
set delivery_status = 'متاح'
where fulfillment_status = 'مكتمل'
  and (payment_method = 'cash' or status = 'تم تأكيد الدفع')
  and delivery_status = 'غير جاهز';

alter table public.store_orders enable row level security;
revoke all on table public.store_orders from public, anon, authenticated;
grant insert on table public.store_orders to anon, authenticated;

drop policy if exists store_orders_anon_insert on public.store_orders;
create policy store_orders_anon_insert
  on public.store_orders
  for insert
  to anon, authenticated
  with check (
    (payment_method = 'cash' and receipt_path is null and status = 'طلب جديد')
    or
    (payment_method in ('wallet', 'instapay') and receipt_path is not null and status = 'بانتظار تأكيد الدفع')
  );

create table if not exists public.store_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.store_admins enable row level security;
revoke all on table public.store_admins from public, anon, authenticated;
grant select on table public.store_admins to authenticated;

drop policy if exists store_admins_read_self on public.store_admins;
create policy store_admins_read_self
  on public.store_admins
  for select
  to authenticated
  using (user_id = (select auth.uid()));

grant select on table public.store_orders to authenticated;
grant update (status, fulfillment_status) on table public.store_orders to authenticated;

drop policy if exists store_orders_admin_select on public.store_orders;
create policy store_orders_admin_select
  on public.store_orders
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.store_admins
      where user_id = (select auth.uid())
    )
  );

drop policy if exists store_orders_admin_update_status on public.store_orders;
create policy store_orders_admin_update_status
  on public.store_orders
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.store_admins
      where user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.store_admins
      where user_id = (select auth.uid())
    )
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-receipts', 'payment-receipts', false, 1048576, array['image/jpeg'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists payment_receipts_anon_upload on storage.objects;
grant insert on table storage.objects to anon, authenticated;
create policy payment_receipts_anon_upload
  on storage.objects
  for insert
  to anon, authenticated
  with check (
    bucket_id = 'payment-receipts'
    and (storage.foldername(name))[1] = 'orders'
    and array_length(storage.foldername(name), 1) = 1
    and lower(storage.extension(name)) = 'jpg'
  );

grant select on table storage.objects to authenticated;
drop policy if exists payment_receipts_admin_read on storage.objects;
create policy payment_receipts_admin_read
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'payment-receipts'
    and exists (
      select 1
      from public.store_admins
      where user_id = (select auth.uid())
    )
  );

create or replace function public.lookup_store_order(p_code text, p_phone text)
returns table (payment_status text, fulfillment_status text)
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select orders.status, orders.fulfillment_status
  from public.store_orders as orders
  where orders.code = upper(btrim(p_code))
    and orders.normalized_phone = p_phone
  limit 1;
$$;

revoke all on function public.lookup_store_order(text, text) from public, anon, authenticated;
grant execute on function public.lookup_store_order(text, text) to anon, authenticated;

notify pgrst, 'reload schema';

create or replace function public.sync_store_delivery_readiness()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.fulfillment_status = 'مكتمل'
    and (new.payment_method = 'cash' or new.status = 'تم تأكيد الدفع')
    and new.delivery_status = 'غير جاهز' then
    new.delivery_status := 'متاح';
  elsif new.fulfillment_status <> 'مكتمل' and new.delivery_status = 'متاح' then
    new.delivery_status := 'غير جاهز';
  end if;
  return new;
end;
$$;

drop trigger if exists store_orders_sync_delivery_readiness on public.store_orders;
create trigger store_orders_sync_delivery_readiness
  before update of fulfillment_status, status on public.store_orders
  for each row execute function public.sync_store_delivery_readiness();

create or replace function public.count_store_orders_delivered_today()
returns bigint
language sql
stable
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
  select count(*)
  from public.store_orders
  where delivery_status = 'تم التوصيل'
    and delivered_at >= timezone('Africa/Cairo', date_trunc('day', timezone('Africa/Cairo', now())));
$$;

revoke all on function public.count_store_orders_delivered_today() from public, anon, authenticated;
grant execute on function public.count_store_orders_delivered_today() to authenticated;

drop function if exists public.list_store_delivery_orders();
create function public.list_store_delivery_orders()
returns table (
  id uuid,
  code text,
  created_at timestamptz,
  customer text,
  phone text,
  address text,
  notes text,
  items jsonb,
  delivery_fee numeric,
  delivery_distance_km numeric,
  delivery_latitude numeric,
  delivery_longitude numeric,
  total numeric,
  payment_method text,
  payment_status text,
  delivery_status text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not exists (select 1 from public.store_delivery_staff where user_id = auth.uid()) then
    raise exception 'not authorized';
  end if;

  return query
  select orders.id, orders.code, orders.created_at, orders.customer, orders.phone,
    orders.address, orders.notes, orders.items, orders.delivery_fee, orders.delivery_distance_km,
    orders.delivery_latitude, orders.delivery_longitude, orders.total, orders.payment_method,
    orders.status, orders.delivery_status
  from public.store_orders as orders
  where orders.fulfillment_status = 'مكتمل'
    and (orders.payment_method = 'cash' or orders.status = 'تم تأكيد الدفع')
    and (
      orders.delivery_status = 'متاح'
      or (orders.delivery_status = 'مع المندوب' and orders.delivery_user_id = auth.uid())
    )
  order by orders.created_at;
end;
$$;

create or replace function public.claim_store_delivery_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not exists (select 1 from public.store_delivery_staff where user_id = auth.uid()) then
    raise exception 'not authorized';
  end if;

  update public.store_orders as orders
  set delivery_status = 'مع المندوب', delivery_user_id = auth.uid()
  where orders.id = p_order_id
    and orders.fulfillment_status = 'مكتمل'
    and (orders.payment_method = 'cash' or orders.status = 'تم تأكيد الدفع')
    and orders.delivery_status = 'متاح';
  return found;
end;
$$;

create or replace function public.complete_store_delivery_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not exists (select 1 from public.store_delivery_staff where user_id = auth.uid()) then
    raise exception 'not authorized';
  end if;

  update public.store_orders as orders
  set delivery_status = 'تم التوصيل', delivered_at = now()
  where orders.id = p_order_id
    and orders.delivery_status = 'مع المندوب'
    and orders.delivery_user_id = auth.uid();
  return found;
end;
$$;

revoke all on function public.list_store_delivery_orders() from public, anon;
revoke all on function public.claim_store_delivery_order(uuid) from public, anon;
revoke all on function public.complete_store_delivery_order(uuid) from public, anon;
grant execute on function public.list_store_delivery_orders() to authenticated;
grant execute on function public.claim_store_delivery_order(uuid) to authenticated;
grant execute on function public.complete_store_delivery_order(uuid) to authenticated;

notify pgrst, 'reload schema';
