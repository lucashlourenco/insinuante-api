import fs from 'fs';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { Pool } from 'pg';
import 'dotenv/config';
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-12-15.clover'
});

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
        where: { email, password },
        include: { shop: true } 
    });

    if (!user) return res.status(401).json({ error: "Credenciais inválidas" });
    res.json(user);
});

// --- ROTA DE TESTE (Para saber se o server está vivo) ---
app.get('/', (req, res) => res.send('Backend Insinuante está ON! ✅'));


app.post('/products', upload.array('files'), async (req, res) => {
    console.log('--- Nova tentativa de cadastro recebida ---');

    try {
        const { name, description, price, stock, category, variations, shopId } = req.body;
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
                variations: variations ? JSON.parse(variations) : [],
                shopId: shopId // 👈 Vincula o produto à loja do vendedor
            }
        });

        res.status(201).json(product);
    } catch (error) {
        console.error('❌ Erro no cadastro:', error);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

app.get('/products', async (req, res) => {
    const { search, shopId } = req.query;

    try {
        const products = await prisma.product.findMany({
            where: {
                ...(shopId ? { shopId: String(shopId) } : {}),
                ...(search ? {
                    name: {
                        contains: String(search),
                        mode: 'insensitive',
                    },
                } : {}),
            },
            // 👈 IMPORTANTE: Inclui os dados da loja associada ao produto
            include: {
                shop: true
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json(products);
    } catch (error) {
        console.error("Erro ao buscar produtos:", error);
        res.status(500).json({ error: "Erro ao buscar produtos" });
    }
});

// Adicione também uma rota para buscar UM produto específico pelo ID
app.get('/products/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const product = await prisma.product.findUnique({
            where: { id },
            include: { shop: true } // 👈 Traz o perfil do vendedor aqui também
        });
        res.json(product);
    } catch (error) {
        res.status(404).json({ error: "Produto não encontrado" });
    }
});


app.post('/orders', async (req, res) => {
    const { customerId, total, paymentMethod, addressId, items } = req.body;

    try {
        // Usamos $transaction para que tudo aconteça ou nada aconteça
        const result = await prisma.$transaction(async (tx) => {
            // 1. Criar o Pedido
            const order = await tx.order.create({
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
                }
            });

            // 2. Baixar o estoque de cada produto
            for (const item of items) {
                await tx.product.update({
                    where: { id: item.id },
                    data: {
                        stock: { decrement: item.quantity }, // Diminui a quantidade exata
                        sold: { increment: item.quantity }   // Aumenta o contador de vendas
                    }
                });
            }

            return order;
        });

        console.log(`✅ Pedido ${result.id} finalizado com baixa de estoque.`);
        res.status(201).json(result);
    } catch (error) {
        console.error("❌ Erro no checkout:", error);
        res.status(500).json({ error: "Erro ao processar pagamento ou falta de estoque." });
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

// Rota para Upload Único de Imagem (Perfil da Loja, etc)
app.post('/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        }

        console.log('📤 Fazendo upload da imagem para o Cloudinary...');

        // 1. Envia o arquivo que o multer salvou na pasta 'uploads/' para o Cloudinary
        const result = await cloudinary.uploader.upload(req.file.path, {
            folder: 'insinuante_profile', // Organiza em uma pasta específica
        });

        // 2. Apaga o arquivo temporário da sua pasta 'uploads/' local
        fs.unlinkSync(req.file.path);

        // 3. Retorna a URL segura para o Frontend
        res.json({ url: result.secure_url });
    } catch (error) {
        console.error('❌ Erro no upload:', error);
        res.status(500).json({ error: 'Erro ao processar upload da imagem.' });
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

app.get('/addresses/user/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const addresses = await prisma.address.findMany({
            where: { userId }
        });
        res.json(addresses);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar endereços" });
    }
});

app.post('/payments/intent', async (req, res) => {
    const { amount } = req.body; // Valor em cêntimos (ex: R$ 10,00 = 1000)

    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount,
            currency: 'brl',
            payment_method_types: ['card'],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});


app.get('/seller/stats/:shopId', async (req, res) => {
    const { shopId } = req.params;

    try {
        const orders = await prisma.order.findMany({
            where: {
                items: {
                    some: {
                        product: { 
                            shopId: shopId
                        }
                    }
                }
            },
            select: {
                status: true
            }
        });

        // Contabilizamos os totais por status
        const stats = {
            aPagar: orders.filter(o => o.status === 'A Pagar').length,
            aEnviar: orders.filter(o => o.status === 'A Enviar').length,
            enviado: orders.filter(o => o.status === 'Enviando').length,
            cancelado: orders.filter(o => o.status === 'Cancelado').length,
        };

        res.json(stats);
    } catch (error) {
        console.error("Erro ao buscar estatísticas:", error);
        res.status(500).json({ error: "Erro ao carregar dados do dashboard" });
    }
});


app.get('/seller/sales-chart/:shopId', async (req, res) => {
    const { shopId } = req.params;
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    try {
        const orders = await prisma.order.findMany({
            where: {
                date: { gte: sevenDaysAgo }, // 👈 Alterado de createdAt para date
                items: { some: { product: { shopId: shopId } } }
            },
            select: { total: true, date: true } // 👈 Alterado de createdAt para date
        });

        const chartData = Array.from({ length: 7 }).map((_, i) => {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateString = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

            const dayTotal = orders
                .filter(o => o.date.toLocaleDateString() === date.toLocaleDateString()) // 👈 Alterado para o.date
                .reduce((sum, o) => sum + o.total, 0);

            return { name: dateString, sales: dayTotal };
        }).reverse();

        res.json(chartData);
    } catch (error) {
        res.status(500).json({ error: "Erro ao gerar dados do gráfico" });
    }
});

app.get('/seller/income/:shopId', async (req, res) => {
    const { shopId } = req.params;

    try {
        const orders = await prisma.order.findMany({
            where: {
                items: {
                    some: {
                        product: { shopId: shopId }
                    }
                }
            },
            include: {
                customer: { select: { name: true } } // Para exibir o nome do comprador
            },
            orderBy: { date: 'desc' }
        });

        // Mapeia os dados para o formato esperado pelo frontend
        const incomeData = orders.map(order => {
            const netAmount = order.total * 0.90; // Subtrai 10% de comissão
            
            return {
                id: order.id,
                orderId: `#${order.id.split('-')[0].toUpperCase()}`,
                date: new Date(order.date).toLocaleDateString('pt-BR'),
                buyerName: order.customer?.name || 'Comprador',
                amount: netAmount,
                // Lógica de Liberação: Apenas pedidos "Concluído" são liberados
                status: order.status === 'Concluído' ? 'Liberado' : 'Pendente'
            };
        });

        res.json(incomeData);
    } catch (error) {
        res.status(500).json({ error: "Erro ao carregar dados financeiros" });
    }
});

// insinuante-api/src/server.ts

// Rota para buscar todos os pedidos de uma loja específica
app.get('/seller/orders/:shopId', async (req, res) => {
    const { shopId } = req.params;

    try {
        const orders = await prisma.order.findMany({
            where: {
                items: {
                    some: { product: { shopId: shopId } }
                }
            },
            include: {
                items: true,
                customer: { select: { name: true } }
            },
            orderBy: { date: 'desc' }
        });
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar pedidos" });
    }
});

// Rota para atualizar o status do pedido (ex: Enviar Pedido)
app.patch('/orders/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    try {
        const updatedOrder = await prisma.order.update({
            where: { id: id },
            data: { status: status }
        });
        res.json(updatedOrder);
    } catch (error) {
        res.status(500).json({ error: "Erro ao atualizar status do pedido" });
    }
});

// Rota para buscar os dados atuais da loja
app.get('/shops/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const shop = await prisma.shop.findUnique({
            where: { id }
        });
        res.json(shop);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar perfil da loja" });
    }
});

// Rota para atualizar os dados da loja
app.put('/shops/:id', async (req, res) => {
    const { id } = req.params;
    const { name, description, image } = req.body;

    try {
        const updatedShop = await prisma.shop.update({
            where: { id },
            data: { name, description, image }
        });
        res.json(updatedShop);
    } catch (error) {
        res.status(500).json({ error: "Erro ao atualizar perfil" });
    }
});

// Rota para buscar dados de um utilizador específico
app.get('/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const user = await prisma.user.findUnique({
            where: { id },
            include: { shop: true }
        });
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar dados do utilizador" });
    }
});

// Rota para atualizar os dados do utilizador
app.put('/users/:id', async (req, res) => {
    const { id } = req.params;
    const { name, email, password, phone, birthdate } = req.body;

    try {
        const updatedUser = await prisma.user.update({
            where: { id },
            data: {
                name,
                email,
                password, // Em produção, lembre-se de encriptar a senha
                phone,
                birthdate
            },
            include: { shop: true }
        });
        res.json(updatedUser);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao atualizar dados da conta" });
    }
});

app.put('/products/:id', async (req, res) => {
    const { id } = req.params;
    const { name, description, price, stock, category, variations, images } = req.body;

    try {
        const product = await prisma.product.update({
            where: { id },
            data: {
                name,
                description,
                price: parseFloat(price),
                stock: parseInt(stock),
                category,
                // Aqui salvamos a lista de URLs (incluindo as que sobraram após a remoção)
                images: images, 
                image: images.length > 0 ? images[0] : 'https://placehold.co/400',
                variations: variations ? (typeof variations === 'string' ? JSON.parse(variations) : variations) : []
            }
        });

        res.json(product);
    } catch (error) {
        console.error("Erro ao atualizar produto:", error);
        res.status(500).json({ error: "Erro ao atualizar o produto no banco de dados." });
    }
});

app.delete('/products/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Remove o produto do banco de dados
        await prisma.product.delete({
            where: { id }
        });

        // 204 significa "Sucesso, mas sem conteúdo para retornar"
        res.status(204).send();
    } catch (error) {
        console.error("❌ Erro ao deletar produto:", error);
        res.status(500).json({ error: "Erro ao excluir o produto. Verifique se ele existe." });
    }
});

// Rota para Criar um Novo Endereço
app.post('/addresses', async (req, res) => {
    const { userId, zipCode, street, number, complement, neighborhood, city, state, isPrimary } = req.body;

    try {
        // Se este for marcado como principal, removemos o "principal" dos outros primeiro
        if (isPrimary) {
            await prisma.address.updateMany({
                where: { userId },
                data: { isPrimary: false }
            });
        }

        const newAddress = await prisma.address.create({
            data: {
                userId, zipCode, street, number, complement, neighborhood, city, state, isPrimary: !!isPrimary
            }
        });
        res.status(201).json(newAddress);
    } catch (error) {
        res.status(500).json({ error: "Erro ao cadastrar endereço." });
    }
});

// Rota para Remover um Endereço
app.delete('/addresses/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await prisma.address.delete({
            where: { id }
        });
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: "Erro ao remover endereço." });
    }
});

// insinuante-api/src/server.ts

app.put('/addresses/:id', async (req, res) => {
    const { id } = req.params;
    const { zipCode, street, number, complement, neighborhood, city, state, isPrimary, userId } = req.body;

    try {
        if (isPrimary) {
            await prisma.address.updateMany({
                where: { userId },
                data: { isPrimary: false }
            });
        }

        const updated = await prisma.address.update({
            where: { id: id }, // Certifique-se que o id é string/number conforme o seu banco
            data: { zipCode, street, number, complement, neighborhood, city, state, isPrimary }
        });
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: "Erro ao atualizar endereço." });
    }
});