import dotenv from 'dotenv'
import { createApp } from './app.js'
import { sequelize } from './models/index.js'

const port = Number(process.env.PORT || 3000)
const app = createApp()

async function bootstrap() {
  await sequelize.authenticate()
  console.log('DB: connected')

  app.listen(port, () => {
    console.log(`Server: http://localhost:${port}`)
    console.log(`Swagger: http://localhost:${port}/api/docs`)
    console.log(`Health:  http://localhost:${port}/health`)
  })
}

bootstrap().catch((e) => {
  console.error('Failed to start:', e.message)
  process.exit(1)
})
