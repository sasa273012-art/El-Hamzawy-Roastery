begin;

alter table public.store_orders
  add column if not exists delivery_fee numeric(10, 2) not null default 0,
  add column if not exists delivery_distance_km numeric(10, 4),
  add column if not exists delivery_latitude numeric(9, 6),
  add column if not exists delivery_longitude numeric(9, 6);

alter table public.store_orders
  drop constraint if exists store_orders_check;
alter table public.store_orders
  drop constraint if exists store_orders_total_check;
alter table public.store_orders
  add constraint store_orders_total_check
  check (total >= 0 and total = greatest(0, subtotal - discount) + delivery_fee)
  not valid;

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
  ) not valid;

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

revoke all on function public.list_store_delivery_orders() from public, anon;
grant execute on function public.list_store_delivery_orders() to authenticated;

notify pgrst, 'reload schema';

commit;

select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'store_orders'
  and column_name in (
    'delivery_fee',
    'delivery_distance_km',
    'delivery_latitude',
    'delivery_longitude'
  )
order by column_name;
