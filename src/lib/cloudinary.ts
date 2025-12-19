import { v2 as cloudinary } from 'cloudinary';
import 'dotenv/config';

// Usamos "as string" para garantir ao TS que o valor não é undefined
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME as string,
  api_key: process.env.CLOUDINARY_API_KEY as string,
  api_secret: process.env.CLOUDINARY_API_SECRET as string,
  secure: true
});

export default cloudinary;