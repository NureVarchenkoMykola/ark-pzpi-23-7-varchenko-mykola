import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { Appliance } from '../models/index.js'

const router = Router()

/**
 * @openapi
 * /api/appliances:
 *   get:
 *     tags:
 *       - Appliances
 *     summary: List appliances for current user
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/', auth, async (req, res, next) => {
  try {
    const rows = await Appliance.findAll({
      where: { user_id: req.user.id },
      order: [['id', 'DESC']]
    })
    res.json(rows)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/appliances:
 *   post:
 *     tags:
 *       - Appliances
 *     summary: Create appliance
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, example: "Boiler" }
 *               description: { type: string, example: "Bathroom boiler" }
 *               estimated_power: { type: number, example: 2.0 }
 *     responses:
 *       201:
 *         description: Created
 */
router.post('/', auth, async (req, res, next) => {
  try {
    const { name, description, estimated_power } = req.body || {}
    if (!name) return res.status(400).json({ message: 'name is required' })

    const created = await Appliance.create({
      user_id: req.user.id,
      name,
      description: description || null,
      estimated_power: estimated_power ?? null
    })

    res.status(201).json(created)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/appliances/{id}:
 *   patch:
 *     tags:
 *       - Appliances
 *     summary: Update appliance
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               estimated_power: { type: number }
 *     responses:
 *       200:
 *         description: OK
 *       404:
 *         description: Not found
 */
router.patch('/:id', auth, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const row = await Appliance.findOne({ where: { id, user_id: req.user.id } })
    if (!row) return res.status(404).json({ message: 'not found' })

    const { name, description, estimated_power } = req.body || {}
    await row.update({
      name: name ?? row.name,
      description: description ?? row.description,
      estimated_power: estimated_power ?? row.estimated_power
    })

    res.json(row)
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/appliances/{id}:
 *   delete:
 *     tags:
 *       - Appliances
 *     summary: Delete appliance
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Deleted
 *       404:
 *         description: Not found
 */
router.delete('/:id', auth, async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const row = await Appliance.findOne({ where: { id, user_id: req.user.id } })
    if (!row) return res.status(404).json({ message: 'not found' })

    await row.destroy()
    res.status(204).send()
  } catch (e) {
    next(e)
  }
})

export default router
