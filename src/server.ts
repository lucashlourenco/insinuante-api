import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { Pool } from 'pg';
import 'dotenv/config';

// Importações com .js devido ao NodeNext
import cloudinary from './lib/cloudinary.js';
import { PrismaClient } from './generated/prisma/client/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

const app = express();
const PORT = 3333;

// Configuração do Prisma 7 com PostgreSQL
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Configuração do Multer (armazenamento temporário na pasta 'uploads')
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());


// insinuante-api/src/server.ts

// insinuante-api/src/server.ts

app.post('/auth/register', async (req, res) => {
    // 1. Adicione este log para ver o que a Web está a enviar
    console.log("📦 Dados recebidos no body:", JSON.stringify(req.body, null, 2));

    const { userData, addressData, shopData } = req.body;

    // Verificação de segurança
    if (!userData || !userData.name) {
        return res.status(400).json({ error: "Dados do usuário (nome, email) são obrigatórios." });
    }

    try {
        const newUser = await prisma.user.create({
            data: {
                name: userData.name,
                email: userData.email,
                password: userData.password,
                cpf: userData.cpf,
                phone: userData.phone,
                birthdate: userData.birthdate,
                role: userData.role || 'SELLER',
                addresses: {
                    create: {
                        zipCode: addressData.cep,
                        street: addressData.street,
                        number: addressData.number,
                        complement: addressData.complement,
                        neighborhood: addressData.neighborhood,
                        city: addressData.city,
                        state: addressData.state,
                        isPrimary: true
                    }
                },
                shop: shopData ? {
                    create: {
                        name: shopData.name,
                        description: shopData.description,
                        image: shopData.image || "https://placehold.co/400"
                    }
                } : undefined
            },
            include: { shop: true }
        });
        res.status(201).json(newUser);
    } catch (error) {
        console.error("❌ Erro no Registo:", error);
        res.status(400).json({ error: "Erro ao criar utilizador. Verifique se o email já existe." });
    }
});

// ROTA DE LOGIN
app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const user = await prisma.user.findFirst({
        where: { email, password } // Em produção, use bcrypt para comparar hashes!
    });

    if (!user) return res.status(401).json({ error: "Credenciais inválidas" });
    res.json(user);
});

// --- ROTA DE TESTE (Para saber se o server está vivo) ---
app.get('/', (req, res) => res.send('Backend Insinuante está ON! ✅'));

// --- ROTA DEFINITIVA DE CADASTRO DE PRODUTO ---
app.post('/products', upload.array('files'), async (req, res) => {
    console.log('--- Nova tentativa de cadastro recebida ---');

    try {
        const { name, description, price, stock, category, variations } = req.body;
        const files = req.files as Express.Multer.File[];

        if (!files || files.length === 0) {
            console.warn('⚠️ Nenhuma imagem foi enviada.');
        }

        // 1. Upload para o Cloudinary
        console.log('📤 Subindo imagens para o Cloudinary...');
        const uploadPromises = files.map(file => cloudinary.uploader.upload(file.path));
        const uploadResults = await Promise.all(uploadPromises);
        const imageUrls = uploadResults.map(result => result.secure_url);

        // 2. Criar no Banco de Dados via Prisma
        console.log('💾 Salvando no PostgreSQL...');
        const product = await prisma.product.create({
            data: {
                name,
                description,
                price: parseFloat(price) || 0,
                stock: parseInt(stock) || 0,
                category,
                image: imageUrls.length > 0 ? imageUrls[0] : 'https://placehold.co/400',
                images: imageUrls,
                variations: variations ? JSON.parse(variations) : []
            }
        });

        console.log('✅ Produto cadastrado com sucesso:', product.id);
        res.status(201).json(product);
    } catch (error) {
        console.error('❌ Erro no cadastro:', error);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

// Listagem para o App Mobile
app.get('/products', async (req, res) => {
    const products = await prisma.product.findMany({
        orderBy: { createdAt: 'desc' }
    });
    res.json(products);
});

// --- ROTA DE CRIAÇÃO DE PEDIDO (Checkout Mobile) ---
app.post('/orders', async (req, res) => {
    try {
        const { customerId, total, paymentMethod, addressId, items } = req.body;

        // Criamos o pedido e os itens do pedido em uma única transação
        const order = await prisma.order.create({
            data: {
                customerId,
                total,
                paymentMethod,
                addressId,
                status: "A Enviar",
                items: {
                    create: items.map((item: any) => ({
                        productId: item.id,
                        name: item.name,
                        quantity: item.quantity,
                        price: item.price,
                        image: item.image
                    }))
                }
            },
            include: { items: true }
        });

        console.log(`📦 Novo pedido recebido! ID: ${order.id}`);
        res.status(201).json(order);
    } catch (error) {
        console.error("❌ Erro ao processar pedido:", error);
        res.status(500).json({ error: "Erro ao fechar pedido" });
    }
});

// --- ROTA PARA O VENDEDOR VER OS PEDIDOS (Web) ---
app.get('/orders', async (req, res) => {
    try {
        const orders = await prisma.order.findMany({
            include: { items: true }, // Traz os produtos de cada pedido
            orderBy: { date: 'desc' }
        });
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar pedidos" });
    }
});

app.get('/cart/:userId', async (req, res) => {
    const { userId } = req.params;
    const items = await prisma.cartItem.findMany({
        where: { userId }
    });
    res.json(items);
});

app.post('/cart', async (req, res) => {
    const { userId, productId, name, price, quantity, image } = req.body;

    // Verifica se o produto já está no carrinho para somar a quantidade
    const existingItem = await prisma.cartItem.findFirst({
        where: { userId, productId }
    });

    if (existingItem) {
        const updated = await prisma.cartItem.update({
            where: { id: existingItem.id },
            data: { quantity: existingItem.quantity + quantity }
        });
        return res.json(updated);
    }

    const newItem = await prisma.cartItem.create({
        data: { userId, productId, name, price, quantity, image }
    });
    res.status(201).json(newItem);
});

// Atualizar quantidade de um item
app.put('/cart/:id', async (req, res) => {
    const { id } = req.params;
    const { quantity } = req.body;
    const updated = await prisma.cartItem.update({
        where: { id },
        data: { quantity }
    });
    res.json(updated);
});

// Remover um item
app.delete('/cart/:id', async (req, res) => {
    const { id } = req.params;
    await prisma.cartItem.delete({ where: { id } });
    res.status(204).send();
});

// Limpar carrinho (usado após o checkout)
app.delete('/cart/user/:userId', async (req, res) => {
    const { userId } = req.params;
    await prisma.cartItem.deleteMany({ where: { userId } });
    res.status(204).send();
});

app.get('/orders/customer/:customerId', async (req, res) => {
    const { customerId } = req.params;
    try {
        const orders = await prisma.order.findMany({
            where: { customerId },
            include: { items: true },
            orderBy: { date: 'desc' } // Mais recentes primeiro
        });
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar seus pedidos" });
    }
});

app.get('/products', async (req, res) => {
    const { search } = req.query; // Pega o termo de busca da URL: ?search=...

    try {
        const products = await prisma.product.findMany({
            where: search ? {
                name: {
                    contains: String(search), // Busca produtos que contenham o termo
                    mode: 'insensitive',      // Ignora maiúsculas/minúsculas
                },
            } : {},
            orderBy: { createdAt: 'desc' }
        });
        res.json(products);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar produtos" });
    }
});

app.listen(3333, '0.0.0.0', () => {
    console.log(`🔥 Insinuante-API rodando em http://localhost:${PORT}`);
});

app.post('/favorites/toggle', async (req, res) => {
    const { userId, productId } = req.body;

    try {
        const existing = await prisma.favorite.findUnique({
            where: { userId_productId: { userId, productId } }
        });

        if (existing) {
            await prisma.favorite.delete({ where: { id: existing.id } });
            return res.json({ favorited: false });
        }

        await prisma.favorite.create({ data: { userId, productId } });
        res.json({ favorited: true });
    } catch (error) {
        res.status(500).json({ error: "Erro ao processar favorito" });
    }
});

// Listar IDs dos produtos favoritados pelo usuário (para o ícone de coração ficar preenchido)
app.get('/favorites/user/:userId', async (req, res) => {
    const { userId } = req.params;
    const favorites = await prisma.favorite.findMany({
        where: { userId },
        select: { productId: true }
    });
    res.json(favorites.map(f => f.productId));
});

app.get('/favorites/details/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const favorites = await prisma.favorite.findMany({
            where: { userId },
            include: {
                product: true // Traz todos os dados do produto relacionado
            }
        });
        // Mapeamos para devolver apenas a lista de produtos
        res.json(favorites.map(f => f.product));
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar detalhes dos favoritos" });
    }
});