-- =====================================================================
-- Enzyme Demand Plan – schema with writeback (Supabase / Postgres)
-- =====================================================================

-- ---------- Fact table: one row per Material x Customer x Country x Month
create table public.demand_plan (
  id                bigint generated always as identity primary key,
  plan_cycle        text        not null default '2026-11',
  material_code     text        not null,
  material_name     text        not null,
  enzyme_family     text        not null,
  formulation       text        not null,          -- Liquid / Granulate / Powder
  industry          text        not null,
  region            text        not null,
  country           text        not null,
  customer          text        not null,
  demand_planner    text        not null,
  period            date        not null,          -- first day of month
  period_type       text        not null check (period_type in ('Actual','Forecast')),
  actual_kg         numeric(14,1),                 -- null for forecast months
  stat_forecast_kg  numeric(14,1) not null,        -- statistical baseline
  consensus_kg      numeric(14,1) not null,        -- S&OP consensus (pre-writeback)
  override_kg       numeric(14,1),                 -- planner writeback (null = no override)
  prior_year_kg     numeric(14,1) not null,
  price_eur_per_kg  numeric(10,2) not null,
  version           integer     not null default 1,  -- optimistic concurrency
  updated_by        text,
  updated_at        timestamptz,
  unique (plan_cycle, material_code, customer, country, period)
);
create index on public.demand_plan (period);
create index on public.demand_plan (region, industry);

comment on column public.demand_plan.override_kg is 'Writeback value from the planner. Final forecast = coalesce(override_kg, consensus_kg).';

-- ---------- Comments (business context attached to a plan cell)
create table public.plan_comment (
  id            bigint generated always as identity primary key,
  plan_id       bigint not null references public.demand_plan(id) on delete cascade,
  category      text   not null check (category in (
                  'Tender pending','Customer confirmed','New business','Lost business',
                  'Price change','Promotion / campaign','Supply constraint',
                  'Regulatory','Phasing / timing','Other')),
  body          text   not null check (length(body) between 1 and 1000),
  author        text   not null,
  status        text   not null default 'Open' check (status in ('Open','Resolved')),
  created_at    timestamptz not null default now(),
  resolved_by   text,
  resolved_at   timestamptz
);
create index on public.plan_comment (plan_id);

-- ---------- Audit log (append-only)
create table public.plan_audit (
  id          bigint generated always as identity primary key,
  plan_id     bigint not null references public.demand_plan(id) on delete cascade,
  action      text   not null,            -- OVERRIDE / CLEAR_OVERRIDE / COMMENT / RESOLVE
  old_kg      numeric(14,1),
  new_kg      numeric(14,1),
  detail      text,
  actor       text   not null,
  created_at  timestamptz not null default now()
);
create index on public.plan_audit (plan_id);
create index on public.plan_audit (created_at desc);

-- ---------- Reporting view (what the dashboard reads)
create view public.v_demand_plan with (security_invoker = true) as
select p.*,
       coalesce(p.override_kg, p.consensus_kg)                         as final_forecast_kg,
       coalesce(p.override_kg, p.consensus_kg) * p.price_eur_per_kg    as final_forecast_eur,
       p.actual_kg * p.price_eur_per_kg                                as actual_eur,
       p.prior_year_kg * p.price_eur_per_kg                            as prior_year_eur,
       (p.override_kg is not null)                                     as is_overridden,
       (select count(*) from public.plan_comment c
         where c.plan_id = p.id and c.status = 'Open')                 as open_comments
from public.demand_plan p;

-- ---------- Row-level security: anon/authenticated may READ only.
-- All writes go through the validated SECURITY DEFINER functions below.
alter table public.demand_plan  enable row level security;
alter table public.plan_comment enable row level security;
alter table public.plan_audit   enable row level security;

create policy "read plan"     on public.demand_plan  for select to anon, authenticated using (true);
create policy "read comments" on public.plan_comment for select to anon, authenticated using (true);
create policy "read audit"    on public.plan_audit   for select to anon, authenticated using (true);

revoke insert, update, delete on public.demand_plan, public.plan_comment, public.plan_audit from anon, authenticated;

-- ---------- Writeback: forecast override
create or replace function public.writeback_forecast(
  p_id bigint, p_override_kg numeric, p_user text, p_expected_version int, p_note text default null)
returns public.demand_plan
language plpgsql security definer set search_path = public as $$
declare r public.demand_plan; v_old numeric;
begin
  if coalesce(trim(p_user),'') = '' then raise exception 'A user name is required'; end if;
  select * into r from demand_plan where id = p_id for update;
  if not found then raise exception 'Plan row % not found', p_id; end if;
  if r.period_type <> 'Forecast' then raise exception 'Actual periods are locked'; end if;
  if r.version <> p_expected_version then
    raise exception 'CONFLICT: row was changed by % at % – refresh and retry', r.updated_by, r.updated_at
      using errcode = '40001';
  end if;
  if p_override_kg is not null and (p_override_kg < 0 or p_override_kg > 10000000) then
    raise exception 'Override must be between 0 and 10,000,000 kg';
  end if;
  v_old := coalesce(r.override_kg, r.consensus_kg);
  update demand_plan
     set override_kg = round(p_override_kg,1), version = version + 1,
         updated_by = p_user, updated_at = now()
   where id = p_id returning * into r;
  insert into plan_audit(plan_id, action, old_kg, new_kg, detail, actor)
  values (p_id, case when p_override_kg is null then 'CLEAR_OVERRIDE' else 'OVERRIDE' end,
          v_old, coalesce(r.override_kg, r.consensus_kg), p_note, p_user);
  return r;
end $$;

-- ---------- Writeback: bulk % adjustment over a list of rows
create or replace function public.writeback_bulk_pct(p_ids bigint[], p_pct numeric, p_user text, p_note text default null)
returns integer
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if coalesce(trim(p_user),'') = '' then raise exception 'A user name is required'; end if;
  if p_pct <= -100 or p_pct > 200 then raise exception 'Percentage must be greater than -100 and at most 200'; end if;
  if array_length(p_ids,1) > 2000 then raise exception 'Too many rows in one bulk edit'; end if;
  with upd as (
    update demand_plan d
       set override_kg = round(coalesce(d.override_kg, d.consensus_kg) * (1 + p_pct/100.0), 1),
           version = version + 1, updated_by = p_user, updated_at = now()
     where d.id = any(p_ids) and d.period_type = 'Forecast'
    returning d.id, d.override_kg, round(d.override_kg / (1 + p_pct/100.0),1) as old_kg
  )
  insert into plan_audit(plan_id, action, old_kg, new_kg, detail, actor)
  select id, 'BULK_ADJUST', old_kg, override_kg,
         format('%s%s%%%s', case when p_pct>=0 then '+' else '' end, p_pct, coalesce(' – '||p_note,'')), p_user
    from upd;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- Writeback: comments
create or replace function public.add_plan_comment(p_id bigint, p_category text, p_body text, p_user text)
returns public.plan_comment
language plpgsql security definer set search_path = public as $$
declare c public.plan_comment;
begin
  if coalesce(trim(p_user),'') = '' then raise exception 'A user name is required'; end if;
  insert into plan_comment(plan_id, category, body, author)
  values (p_id, p_category, trim(p_body), p_user) returning * into c;
  insert into plan_audit(plan_id, action, detail, actor)
  values (p_id, 'COMMENT', p_category || ': ' || left(trim(p_body), 200), p_user);
  return c;
end $$;

create or replace function public.resolve_plan_comment(p_comment_id bigint, p_user text)
returns public.plan_comment
language plpgsql security definer set search_path = public as $$
declare c public.plan_comment;
begin
  update plan_comment set status = 'Resolved', resolved_by = p_user, resolved_at = now()
   where id = p_comment_id and status = 'Open' returning * into c;
  if not found then raise exception 'Comment not found or already resolved'; end if;
  insert into plan_audit(plan_id, action, detail, actor)
  values (c.plan_id, 'RESOLVE', c.category || ' comment resolved', p_user);
  return c;
end $$;

revoke execute on function public.writeback_forecast, public.writeback_bulk_pct,
  public.add_plan_comment, public.resolve_plan_comment from public;
grant execute on function public.writeback_forecast, public.writeback_bulk_pct,
  public.add_plan_comment, public.resolve_plan_comment to anon, authenticated;
