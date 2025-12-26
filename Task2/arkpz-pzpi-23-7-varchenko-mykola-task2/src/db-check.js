import dotenv from 'dotenv'
import { Sequelize } from 'sequelize'

dotenv.config()

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    dialect: 'mysql',
    logging: false
  }
)

try {
  await sequelize.authenticate()
  console.log('OK: Connected to MySQL')
  process.exit(0)
} catch (e) {
  console.error('FAIL: Cannot connect to MySQL')
  console.error(e.message)
  process.exit(1)
}
