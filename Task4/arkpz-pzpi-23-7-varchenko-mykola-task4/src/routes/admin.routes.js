import { Router } from 'express'
import { Op } from 'sequelize'
import { User, AuditLog } from '../models/index.js'
import { auth, requireAdmin } from '../middleware/auth.js'

const router = Router()

router.use(auth)
router.use(requireAdmin)

const ROLES = new Set(['user', 'admin'])

function parseBool(v) {
  if (v === true || v === false) return v
  if (v === 1 || v === 0) return Boolean(v)
  if (typeof v === 'string') {
    if (v === 'true') return true
    if (v === 'false') return false
    if (v === '1') return true
    if (v === '0') return false
  }
  return null
}

async function countActiveAdmins() {
  return User.count({ where: { role: 'admin', is_blocked: false } })
}

async function writeAudit(req, action, targetUserId = null, detailsObj = null) {
  try {
    await AuditLog.create({
      admin_id: req.user.id,
      action,
      target_user_id: targetUserId,
      details: detailsObj ? JSON.stringify(detailsObj) : null
    })
  } catch (e) {
    console.error('AuditLog write failed:', e)
  }
}

/**
 * @openapi
 * /api/admin/users:
 *   get:
 *     tags:
 *       - Admin
 *     summary: List users with filters (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string, example: "mail.com" }
 *         description: Filter by email substring
 *       - in: query
 *         name: role
 *         schema: { type: string, enum: [user, admin], example: "user" }
 *       - in: query
 *         name: is_blocked
 *         schema: { type: boolean, example: false }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, example: 50 }
 *         description: Default 50, max 200
 *       - in: query
 *         name: offset
 *         schema: { type: integer, example: 0 }
 *         description: Default 0
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total: { type: integer, example: 10 }
 *                 limit: { type: integer, example: 50 }
 *                 offset: { type: integer, example: 0 }
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       email: { type: string }
 *                       role: { type: string, enum: [user, admin] }
 *                       is_blocked: { type: boolean }
 *                       created_at: { type: string, format: date-time }
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin only
 */
router.get('/users', async (req, res, next) => {
  try {
    const q = req.query.q != null ? String(req.query.q).trim() : ''
    const role = req.query.role != null ? String(req.query.role).trim() : null
    const isBlockedRaw = req.query.is_blocked != null ? req.query.is_blocked : null

    const limitRaw = req.query.limit != null ? Number(req.query.limit) : 50
    const offsetRaw = req.query.offset != null ? Number(req.query.offset) : 0
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 200) : 50
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0

    if (role && !ROLES.has(role)) {
      return res.status(400).json({ message: 'role must be user or admin' })
    }

    const where = {}
    if (q) where.email = { [Op.like]: `%${q}%` }
    if (role) where.role = role

    if (isBlockedRaw != null) {
      const parsed = parseBool(isBlockedRaw)
      if (parsed == null) return res.status(400).json({ message: 'is_blocked must be boolean' })
      where.is_blocked = parsed
    }

    const result = await User.findAndCountAll({
      where,
      attributes: ['id', 'email', 'role', 'is_blocked', 'created_at'],
      order: [['id', 'ASC']],
      limit,
      offset
    })

    res.json({
      total: result.count,
      limit,
      offset,
      items: result.rows
    })
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/admin/users/{id}/role:
 *   patch:
 *     tags:
 *       - Admin
 *     summary: Change user role (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 4 }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role]
 *             properties:
 *               role:
 *                 type: string
 *                 enum: [user, admin]
 *                 example: "admin"
 *     responses:
 *       200:
 *         description: OK
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin only
 *       404:
 *         description: Not found
 *       409:
 *         description: Conflict (last admin protection)
 */
router.patch('/users/:id/role', async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'invalid id' })
    }

    const nextRole = String((req.body || {}).role || '').trim()
    if (!ROLES.has(nextRole)) {
      return res.status(400).json({ message: 'role must be user or admin' })
    }

    if (id === req.user.id && nextRole !== 'admin') {
    return res.status(400).json({ message: 'cannot change own role' })
    }

    const user = await User.findByPk(id, {
      attributes: ['id', 'email', 'role', 'is_blocked', 'created_at']
    })
    if (!user) return res.status(404).json({ message: 'not found' })

    if (user.role === 'admin' && nextRole !== 'admin') {
    const activeAdmins = await countActiveAdmins()
    if (activeAdmins <= 1) {
        return res.status(409).json({ message: 'cannot remove role from the last active admin' })
    }
    }

		const prevRole = user.role
    await user.update({ role: nextRole })

		await writeAudit(req, 'USER_ROLE_CHANGE', user.id, {
			from: prevRole,
			to: nextRole,
			email: user.email
		})

    res.json(user)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/admin/users/{id}/block:
 *   patch:
 *     tags:
 *       - Admin
 *     summary: Block or unblock user (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, example: 3 }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [is_blocked]
 *             properties:
 *               is_blocked: { type: boolean, example: true }
 *     responses:
 *       200:
 *         description: OK
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin only
 *       404:
 *         description: Not found
 *       409:
 *         description: Conflict (last admin protection)
 */
router.patch('/users/:id/block', async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'invalid id' })
    }

    const parsed = parseBool((req.body || {}).is_blocked)
    if (parsed == null) {
      return res.status(400).json({ message: 'is_blocked must be boolean' })
    }

    if (parsed === true && id === req.user.id) {
      return res.status(400).json({ message: 'cannot block own account' })
    }

    const user = await User.findByPk(id, {
      attributes: ['id', 'email', 'role', 'is_blocked', 'created_at']
    })
    if (!user) return res.status(404).json({ message: 'not found' })

		if (parsed === true && user.role === 'admin') {
			const activeAdmins = await countActiveAdmins()
			if (activeAdmins <= 1) {
				return res.status(409).json({ message: 'cannot block the last active admin' })
			}
		}

		const prevBlocked = user.is_blocked
    await user.update({ is_blocked: parsed })

		await writeAudit(req, parsed ? 'USER_BLOCK' : 'USER_UNBLOCK', user.id, {
			from: prevBlocked,
			to: parsed,
			email: user.email
		})

    res.json(user)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/admin/stats:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Admin statistics (counts)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accounts_total: { type: integer, example: 10 }
 *                 accounts_blocked_total: { type: integer, example: 2 }
 *                 users_total: { type: integer, example: 8 }
 *                 users_blocked_total: { type: integer, example: 1 }
 *                 admins_total: { type: integer, example: 2 }
 *                 admins_blocked_total: { type: integer, example: 1 }
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin only
 */
router.get('/stats', async (req, res, next) => {
  try {
    const [
      accountsTotal,
      accountsBlockedTotal,
      usersTotal,
      usersBlockedTotal,
      adminsTotal,
      adminsBlockedTotal
    ] = await Promise.all([
      User.count(),
      User.count({ where: { is_blocked: true } }),
      User.count({ where: { role: 'user' } }),
      User.count({ where: { role: 'user', is_blocked: true } }),
      User.count({ where: { role: 'admin' } }),
      User.count({ where: { role: 'admin', is_blocked: true } })
    ])

    res.json({
      accounts_total: accountsTotal,
      accounts_blocked_total: accountsBlockedTotal,
      users_total: usersTotal,
      users_blocked_total: usersBlockedTotal,
      admins_total: adminsTotal,
      admins_blocked_total: adminsBlockedTotal
    })
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/admin/audit-logs:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Audit logs (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: admin_id
 *         schema: { type: integer, example: 1 }
 *         description: Filter by specific admin id (optional)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, example: 50 }
 *         description: Default 50, max 200
 *       - in: query
 *         name: offset
 *         schema: { type: integer, example: 0 }
 *         description: Default 0
 *     responses:
 *       200:
 *         description: OK
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin only
 */
router.get('/audit-logs', async (req, res, next) => {
  try {
    const adminIdStr = req.query.admin_id != null ? String(req.query.admin_id).trim() : ''
		const adminIdRaw = adminIdStr ? Number(adminIdStr) : null

    const limitRaw = req.query.limit != null ? Number(req.query.limit) : 50
    const offsetRaw = req.query.offset != null ? Number(req.query.offset) : 0
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 200) : 50
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0

    const where = {}
    if (adminIdRaw != null) {
      if (!Number.isInteger(adminIdRaw) || adminIdRaw <= 0) {
        return res.status(400).json({ message: 'admin_id must be positive integer' })
      }
      where.admin_id = adminIdRaw
    }

    const result = await AuditLog.findAndCountAll({
      where,
      attributes: ['id', 'admin_id', 'action', 'target_user_id', 'details', 'created_at'],
      include: [
        { model: User, as: 'admin', attributes: ['id', 'email'] },
        { model: User, as: 'target_user', attributes: ['id', 'email'] }
      ],
      order: [['id', 'DESC']],
      limit,
      offset
    })

    res.json({
      total: result.count,
      limit,
      offset,
      items: result.rows
    })
  } catch (e) {
    next(e)
  }
})

export default router
