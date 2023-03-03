import express, { Express, Request, Response } from 'express';
import dotenv from 'dotenv';
import valueChange from './utils/value-change';

dotenv.config();

const app: Express = express();
const port = process.env.PORT;

app.get('/', async (req: Request, res: Response) => {
  const { tx: txhash } = req.query;
  if (typeof txhash !== 'string') {
    res.send('Cannot find transaction. Please input transaction hash like this: /?tx=0x1234');
  } else {
    const changes = await valueChange(txhash);
    res.send(JSON.stringify(changes, (_, v) => typeof v === 'bigint' ? v.toString() : v));
  }
});

app.listen(port, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
});