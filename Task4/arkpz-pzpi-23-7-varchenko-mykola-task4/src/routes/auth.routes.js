import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { User } from '../models/index.js'
import { auth } from '../middleware/auth.js'

const router = Router()

/**
 * @openapi
 * /api/auth/register:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Register new user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, example: "user@mail.com" }
 *               password: { type: string, example: "password123" }
 *     responses:
 *       201:
 *         description: Created
 *       400:
 *         description: Validation error
 */
router.post('/register', async (req, res, next) => {
  try {
    const { email, password } = req.body || {}
    if (!email || !password) {
      return res.status(400).json({ message: 'email and password are required' })
    }

    const exists = await User.findOne({ where: { email } })
    if (exists) {
      return res.status(400).json({ message: 'email already exists' })
    }

    const password_hash = await bcrypt.hash(password, 10)
    const user = await User.create({ email, password_hash })

    return res.status(201).json({ id: user.id, email: user.email })
  } catch (e) {
    next(e)
  }
})

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Login user and get JWT
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, example: "user@mail.com" }
 *               password: { type: string, example: "password123" }
 *     responses:
 *       200:
 *         description: OK
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {}
    const user = await User.findOne({ where: { email } })
    
    if (!user) return res.status(401).json({ message: 'invalid credentials' })
    if (user.is_blocked) return res.status(403).json({ message: 'User is blocked' })

    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) return res.status(401).json({ message: 'invalid credentials' })

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' })
    return res.json({ token })
  } catch (e) {
    next(e)
  }
})


/**
 * @openapi
 * /api/auth/me:
 *   get:
 *     tags:
 *       - Auth
 *     summary: Get current user id from token
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *       401:
 *         description: Unauthorized
 */
router.get('/me', auth, async (req, res) => {
  res.json({ id: req.user.id, role: req.user.role })
})


export default router
