import { Router, type Request } from 'express';
import type { PoolClient } from 'pg';
import { memberByEmailSchema, BusinessRole, uuidSchema, slugSchema, businessCreateSchema, businessPatchSchema, branchCreateSchema, branchPatchSchema, serviceCreateSchema, servicePatchSchema, counterCreateSchema, counterPatchSchema, memberCreateSchema, memberPatchSchema, assignmentsSchema, type BusinessDto, type CounterDto } from '@qevra/contracts';
import { requireAuth, requireStaff } from '../../middleware/authentication.js';
import { withTransaction } from '../../db/transaction.js';
import { HttpError } from '../../shared/http-error.js';
import { allow, businessScope, branchAccess, serviceAccess, missing, type Scope } from './access.js';
import { one, businessDto, branchDto, serviceDto, counterDto, counterColumns, listBranches, listServices, members } from './repository.js';
export type TransactionRunner = <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>;
const id = (req: Request, key: string) => uuidSchema.parse(req.params[key]);
const writeRoles = [BusinessRole.OWNER, BusinessRole.MANAGER];

export function createConfigurationRouter(run: TransactionRunner = withTransaction): Router {
  const router = Router();
  router.use(requireAuth, requireStaff);
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const scoped = <T>(req: Request, write: boolean, operation: (client: PoolClient, scope: Scope) => Promise<T>) =>
    run(async client => operation(client, await businessScope(client, id(req, 'businessId'), req.actor!.userId, write)));

  router.get('/', async (req, res) => {
    res.json(await run(async client => (await client.query<BusinessDto>(`SELECT b.id, b.name, b.slug,
      CASE WHEN b.is_active THEN 'ACTIVE' ELSE 'INACTIVE' END AS status, m.role
      FROM public.businesses b JOIN public.business_members m ON m.business_id = b.id
      WHERE m.user_id = $1 AND m.is_active AND (b.is_active OR m.role = 'OWNER') ORDER BY b.name, b.id`, [req.actor!.userId])).rows));
  });
  router.post('/', async (req, res) => {
    const data = businessCreateSchema.parse(req.body);
    const result = await run(async client => {
      await client.query("INSERT INTO public.profiles(user_id, display_name) VALUES ($1, 'Business owner') ON CONFLICT (user_id) DO NOTHING", [req.actor!.userId]);
      const business = await one<{ id: string }>(client, 'INSERT INTO public.businesses(name, slug, is_active, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [data.name, data.slug, data.status === 'ACTIVE', req.actor!.userId]);
      const member = await one<{ id: string }>(client, "INSERT INTO public.business_members(business_id, user_id, role) VALUES ($1, $2, 'OWNER') RETURNING id", [business.id, req.actor!.userId]);
      return businessDto(client, { businessId: business.id, memberId: member.id, role: BusinessRole.OWNER });
    });
    res.status(201).json(result);
  });
  router.get('/:businessId', async (req, res) => res.json(await scoped(req, false, businessDto)));
  router.patch('/:businessId', async (req, res) => {
    const patch = businessPatchSchema.parse(req.body);
    res.json(await scoped(req, true, async (client, scope) => {
      allow(scope, [BusinessRole.OWNER]);
      const data = { ...await businessDto(client, scope), ...patch };
      await client.query('UPDATE public.businesses SET name = $1, slug = $2, is_active = $3 WHERE id = $4', [data.name, data.slug, data.status === 'ACTIVE', scope.businessId]);
      return businessDto(client, scope);
    }));
  });
  router.get('/:businessId/branches', async (req, res) => res.json(await scoped(req, false, listBranches)));
  router.post('/:businessId/branches', async (req, res) => {
    const data = branchCreateSchema.parse(req.body);
    res.status(201).json(await scoped(req, true, async (client, scope) => {
      allow(scope, writeRoles);
      const branch = await one<{ id: string }>(client, 'INSERT INTO public.branches(business_id, name, public_slug, timezone, address, is_active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [scope.businessId, data.name, data.public_slug, data.timezone, data.address, data.is_active]);
      if (scope.role === BusinessRole.MANAGER) await client.query('INSERT INTO public.branch_members(business_id, branch_id, member_id) VALUES ($1, $2, $3)', [scope.businessId, branch.id, scope.memberId]);
      return branchDto(client, scope.businessId, branch.id);
    }));
  });
  router.get('/:businessId/branches/:branchId', async (req, res) => res.json(await scoped(req, false, async (client, scope) => {
    const branchId = id(req, 'branchId'); await branchAccess(client, scope, branchId, false);
    return branchDto(client, scope.businessId, branchId);
  })));
  router.patch('/:businessId/branches/:branchId', async (req, res) => {
    const patch = branchPatchSchema.parse(req.body);
    res.json(await scoped(req, true, async (client, scope) => {
      const branchId = id(req, 'branchId'); await branchAccess(client, scope, branchId, true);
      const data = { ...await branchDto(client, scope.businessId, branchId), ...patch };
      await client.query('UPDATE public.branches SET name=$1, public_slug=$2, timezone=$3, address=$4, is_active=$5 WHERE business_id=$6 AND id=$7', [data.name, data.public_slug, data.timezone, data.address, data.is_active, scope.businessId, branchId]);
      return branchDto(client, scope.businessId, branchId);
    }));
  });
  const services = '/:businessId/branches/:branchId/services';
  router.get(services, async (req, res) => res.json(await scoped(req, false, async (client, scope) => {
    const branchId = id(req, 'branchId'); await branchAccess(client, scope, branchId, false);
    return listServices(client, scope, branchId);
  })));
  router.post(services, async (req, res) => {
    const data = serviceCreateSchema.parse(req.body);
    res.status(201).json(await scoped(req, true, async (client, scope) => {
      const branchId = id(req, 'branchId'); await branchAccess(client, scope, branchId, true);
      const service = await one<{ id: string }>(client, `INSERT INTO public.services(business_id, branch_id, name, description, price_amount, currency, estimated_duration_minutes, queue_prefix, payment_mode, deposit_amount, is_active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [scope.businessId, branchId, data.name, data.description, data.price_amount, data.currency, data.estimated_duration_minutes, data.queue_prefix, data.payment_mode, data.deposit_amount, data.is_active]);
      return serviceDto(client, scope.businessId, branchId, service.id);
    }));
  });
  router.get(services + '/:serviceId', async (req, res) => res.json(await scoped(req, false, async (client, scope) => {
    const branchId = id(req, 'branchId'), serviceId = id(req, 'serviceId'); await serviceAccess(client, scope, branchId, serviceId, false);
    return serviceDto(client, scope.businessId, branchId, serviceId);
  })));
  router.patch(services + '/:serviceId', async (req, res) => {
    const patch = servicePatchSchema.parse(req.body);
    res.json(await scoped(req, true, async (client, scope) => {
      const branchId = id(req, 'branchId'), serviceId = id(req, 'serviceId'); await serviceAccess(client, scope, branchId, serviceId, true);
      const current = await serviceDto(client, scope.businessId, branchId, serviceId);
      const fields = { name: current.name, description: current.description, price_amount: current.price_amount, currency: current.currency, estimated_duration_minutes: current.estimated_duration_minutes, queue_prefix: current.queue_prefix, payment_mode: current.payment_mode, deposit_amount: current.deposit_amount, is_active: current.is_active };
      const data = serviceCreateSchema.parse({ ...fields, ...patch });
      await client.query(`UPDATE public.services SET name=$1, description=$2, price_amount=$3, currency=$4, estimated_duration_minutes=$5, queue_prefix=$6, payment_mode=$7, deposit_amount=$8, is_active=$9
        WHERE business_id=$10 AND branch_id=$11 AND id=$12`, [data.name, data.description, data.price_amount, data.currency, data.estimated_duration_minutes, data.queue_prefix, data.payment_mode, data.deposit_amount, data.is_active, scope.businessId, branchId, serviceId]);
      return serviceDto(client, scope.businessId, branchId, serviceId);
    }));
  });
  router.get(services + '/:serviceId/counters', async (req, res) => res.json(await scoped(req, false, async (client, scope) => {
    const branchId = id(req, 'branchId'), serviceId = id(req, 'serviceId'); await serviceAccess(client, scope, branchId, serviceId, false);
    return (await client.query<CounterDto>('SELECT ' + counterColumns + ' FROM public.service_counters WHERE business_id=$1 AND branch_id=$2 AND service_id=$3 ORDER BY name, id', [scope.businessId, branchId, serviceId])).rows;
  })));
  router.post(services + '/:serviceId/counters', async (req, res) => {
    const data = counterCreateSchema.parse(req.body);
    res.status(201).json(await scoped(req, true, async (client, scope) => {
      const branchId = id(req, 'branchId'), serviceId = id(req, 'serviceId'); await serviceAccess(client, scope, branchId, serviceId, true);
      const counter = await one<{ id: string }>(client, 'INSERT INTO public.service_counters(business_id, branch_id, service_id, name, is_active) VALUES ($1,$2,$3,$4,$5) RETURNING id', [scope.businessId, branchId, serviceId, data.name, data.is_active]);
      return counterDto(client, scope.businessId, branchId, serviceId, counter.id);
    }));
  });
  router.patch(services + '/:serviceId/counters/:counterId', async (req, res) => {
    const patch = counterPatchSchema.parse(req.body);
    res.json(await scoped(req, true, async (client, scope) => {
      const branchId = id(req, 'branchId'), serviceId = id(req, 'serviceId'), counterId = id(req, 'counterId'); await serviceAccess(client, scope, branchId, serviceId, true);
      const data = { ...await counterDto(client, scope.businessId, branchId, serviceId, counterId), ...patch };
      await client.query('UPDATE public.service_counters SET name=$1, is_active=$2 WHERE business_id=$3 AND branch_id=$4 AND service_id=$5 AND id=$6', [data.name, data.is_active, scope.businessId, branchId, serviceId, counterId]);
      return counterDto(client, scope.businessId, branchId, serviceId, counterId);
    }));
  });
  router.get('/:businessId/members', async (req, res) => res.json(await scoped(req, false, async (client, scope) => {
    allow(scope, [BusinessRole.OWNER]); return members(client, scope.businessId);
  })));
  router.post('/:businessId/members/by-email',async(req,res)=>{
    const data=memberByEmailSchema.parse(req.body);
    res.status(201).json(await scoped(req,true,async(client,scope)=>{
      allow(scope,[BusinessRole.OWNER]);
      const user=await client.query<{user_id:string}>(`SELECT p.user_id FROM public.profiles p JOIN auth.users u ON u.id=p.user_id
        WHERE p.normalized_email=$1 AND lower(btrim(u.email))=$1 AND NOT u.is_anonymous
        AND u.email_confirmed_at IS NOT NULL AND u.deleted_at IS NULL`,[data.email]);
      if(!user.rows[0])throw new HttpError(404,'ACCOUNT_NOT_FOUND','No Qevra account was found for this email. Ask this staff member to register first.');
      const member=await one<{id:string}>(client,'INSERT INTO public.business_members(business_id,user_id,role) VALUES($1,$2,$3) RETURNING id',[scope.businessId,user.rows[0].user_id,data.role]);
      return (await members(client,scope.businessId)).find(row=>row.id===member.id);
    }));
  });
  router.post('/:businessId/members', async (req, res) => {
    const data = memberCreateSchema.parse(req.body);
    res.status(201).json(await scoped(req, true, async (client, scope) => {
      allow(scope, [BusinessRole.OWNER]);
      const user = await client.query('SELECT id FROM auth.users WHERE id=$1 AND NOT is_anonymous AND email_confirmed_at IS NOT NULL AND deleted_at IS NULL', [data.user_id]);
      if (!user.rowCount) throw new HttpError(400, 'INVALID_MEMBER', 'Use the UUID of an existing confirmed staff Auth user.');
      await client.query("INSERT INTO public.profiles(user_id, display_name) VALUES ($1, 'Business member') ON CONFLICT (user_id) DO NOTHING", [data.user_id]);
      const member = await one<{ id: string }>(client, 'INSERT INTO public.business_members(business_id, user_id, role) VALUES ($1,$2,$3) RETURNING id', [scope.businessId, data.user_id, data.role]);
      return (await members(client, scope.businessId)).find(row => row.id === member.id);
    }));
  });
  router.patch('/:businessId/members/:memberId', async (req, res) => {
    const patch = memberPatchSchema.parse(req.body);
    res.json(await scoped(req, true, async (client, scope) => {
      allow(scope, [BusinessRole.OWNER]);
      const memberId = id(req, 'memberId');
      const member = (await members(client, scope.businessId)).find(row => row.id === memberId);
      if (!member) throw missing();
      const data = { ...member, ...patch };
      if (member.role === BusinessRole.OWNER && member.is_active && (data.role !== BusinessRole.OWNER || !data.is_active)) {
        const count = await one<{ count: string }>(client, "SELECT count(*)::text AS count FROM public.business_members WHERE business_id=$1 AND role='OWNER' AND is_active", [scope.businessId]);
        if (count.count === '1') throw new HttpError(409, 'LAST_OWNER', 'A business must retain at least one active owner.');
      }
      await client.query('UPDATE public.business_members SET role=$1, is_active=$2 WHERE business_id=$3 AND id=$4', [data.role, data.is_active, scope.businessId, memberId]);
      // Role changes/revocation clear stale scope; owners explicitly reassign it.
      if (data.role !== member.role || !data.is_active) {
        await client.query('DELETE FROM public.staff_services WHERE business_id=$1 AND member_id=$2', [scope.businessId, memberId]);
        await client.query('DELETE FROM public.branch_members WHERE business_id=$1 AND member_id=$2', [scope.businessId, memberId]);
      }
      return (await members(client, scope.businessId)).find(row => row.id === memberId);
    }));
  });
  router.put('/:businessId/members/:memberId/assignments', async (req, res) => {
    const data = assignmentsSchema.parse(req.body);
    res.json(await scoped(req, true, async (client, scope) => {
      allow(scope, [BusinessRole.OWNER]);
      const memberId = id(req, 'memberId');
      const member = (await members(client, scope.businessId)).find(row => row.id === memberId);
      if (!member) throw missing();
      if (!member.is_active || member.role === BusinessRole.OWNER || (member.role === BusinessRole.MANAGER && data.service_ids.length)) throw new HttpError(400, 'INVALID_ASSIGNMENT', 'Assign branches to active managers/staff and services to staff only.');
      const branches = await client.query('SELECT id FROM public.branches WHERE business_id=$1 AND id=ANY($2::uuid[])', [scope.businessId, data.branch_ids]);
      const services = await client.query('SELECT id FROM public.services WHERE business_id=$1 AND branch_id=ANY($2::uuid[]) AND id=ANY($3::uuid[])', [scope.businessId, data.branch_ids, data.service_ids]);
      if (branches.rowCount !== data.branch_ids.length || services.rowCount !== data.service_ids.length) throw new HttpError(400, 'INVALID_ASSIGNMENT', 'Every branch/service must belong to this business and selected branch scope.');
      await client.query('DELETE FROM public.staff_services WHERE business_id=$1 AND member_id=$2', [scope.businessId, memberId]);
      await client.query('DELETE FROM public.branch_members WHERE business_id=$1 AND member_id=$2', [scope.businessId, memberId]);
      for (const branchId of data.branch_ids) await client.query('INSERT INTO public.branch_members(business_id, branch_id, member_id) VALUES ($1,$2,$3)', [scope.businessId, branchId, memberId]);
      for (const serviceId of data.service_ids) await client.query('INSERT INTO public.staff_services(business_id, branch_id, service_id, member_id) SELECT business_id, branch_id, id, $3 FROM public.services WHERE business_id=$1 AND id=$2', [scope.businessId, serviceId, memberId]);
      return (await members(client, scope.businessId)).find(row => row.id === memberId);
    }));
  });
  return router;
}

export function createPublicRouter(run: TransactionRunner = withTransaction, mockEnabled = false): Router {
  const router = Router();
  router.get('/branches/:slug', async (req, res) => {
    const slug = slugSchema.parse(req.params.slug);
    res.set('Cache-Control', 'no-store');
    res.json(await run(async client => {
      const branch = await one<{ id: string; business_id: string; business_name: string; name: string; public_slug: string; address: string | null; timezone: string }>(client, `SELECT br.id, br.business_id, b.name AS business_name, br.name, br.public_slug, br.address, br.timezone
        FROM public.branches br JOIN public.businesses b ON b.id=br.business_id WHERE br.public_slug=$1 AND br.is_active AND b.is_active`, [slug]);
      const services = await client.query(`SELECT s.id, s.name, s.description, s.price_amount::text, s.currency, s.estimated_duration_minutes, s.payment_mode, s.deposit_amount::text,
        coalesce((SELECT qs.status::text FROM public.queue_sessions qs WHERE qs.service_id=s.id AND qs.business_date=(clock_timestamp() AT TIME ZONE br.timezone)::date),'NOT_OPENED') AS queue_status
        FROM public.services s JOIN public.branches br ON br.id=s.branch_id AND br.business_id=s.business_id JOIN public.businesses b ON b.id=s.business_id
        WHERE s.business_id=$1 AND s.branch_id=$2 AND s.is_active AND br.is_active AND b.is_active ORDER BY s.name, s.id`, [branch.business_id, branch.id]);
      return { business_name: branch.business_name, branch: { name: branch.name, public_slug: branch.public_slug, address: branch.address, timezone: branch.timezone }, services: services.rows.map(service=>({...service,online_payment_available:mockEnabled,payment_simulated:mockEnabled&&service.payment_mode!=='NONE'})) };
    }));
  });
  return router;
}
