import nodemailer from 'nodemailer';
import pLimit from 'p-limit';
import fs from 'fs';
import readline from 'readline';
import path from 'path';
import config from './config.json' with {type: "json"};
import * as EmailValidator from 'email-validator';
import { htmlToText } from 'html-to-text';
import chalk from 'chalk';
import OpenAI from "openai";

const openai = new OpenAI({
    apiKey: 'sk-proj-m6JC4OyFyAtplcnMhRR6T3BlbkFJ5Lm5vvnAzMfbP7DpqIOi',
});

// Lista de remetentes com credenciais
let senders = config.senders;
const subject = config.subject;
const recipients_path = config.recipient_path;
const template_path = config.template_path;

const parallelEmails = config.parallel_emails; // Número de e-mails enviados em paralelo
const maxEmailsPerSender = 3000; // Número máximo de e-mails por remetente
const delayBetweenEmails = config.delay_between_emails; // Atraso entre os disparos em milissegundos
const retryDelay = 30000; // Atraso entre tentativas de reenvio em milissegundos
const maxRetries = 3; // Número máximo de tentativas de reenvio
const parallelGeneration = 3; // Número de templates e assuntos gerados em paralelo
const templatesPerBatch = 3; // Número de templates gerados por batch de 500 e-mails
const subjectsPerBatch = 3; // Número de assuntos gerados por batch de 500 e-mails

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createTransporter(sender) {
    return nodemailer.createTransport({
        host: sender.host,
        port: sender.port,
        secure: true,
        auth: {
            user: sender.email,
            pass: sender.password
        },
    });
}

// Função para gerar um novo template de e-mail usando ChatGPT
async function generateEmailTemplate(html) {
    console.log(chalk.yellow('Gerando novo template de e-mail...'));
    const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        temperature: 1,
        max_tokens: 1800,
        top_p: 1,
        frequency_penalty: 0.1,
        presence_penalty: 0.1,
        messages: [
            {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": "Você é um profissional muito respeitado na área de marketing e com mais de 20 anos de experiência em conversão de usuário com problemas alfandegários no correios."
                    }
                ]
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": `Retorne um novo código HTML com o mesmo contexto do e-mail original, mas com um conteúdo mais atraente e persuasivo mas mantenha mas mantenha a formalidade. Seja criativo e preserve os links.`,
                    }
                ]
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": html
                    }
                ]
            }
        ],
    });

    console.log(chalk.green('Template de e-mail gerado com sucesso!'));
    return response.choices[0].message.content;
}

// Função para gerar um novo assunto de e-mail usando ChatGPT
async function generateEmailSubject(subject) {
    console.log(chalk.yellow('Gerando novo assunto de e-mail...'));
    const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 1,
        max_tokens: 150,
        top_p: 1,
        frequency_penalty: 0.1,
        presence_penalty: 0.1,
        messages: [
            {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": "Você é um profissional muito respeitado na área de marketing e com mais de 20 anos de experiência em conversão de usuário recuperação de objetos perdidos. Observe o assunto original do e-mail enviado pela empresa de entrega e retorne um novo assunto que seja mais atrativo e aumente a conversão."
                    },

                ]
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": subject
                    }
                ]
            }
        ],
    });

    console.log(chalk.green('Assunto de e-mail gerado com sucesso!'));
    return response.choices[0].message.content;
}

async function preGenerateTemplatesAndSubjects() {
    console.log(chalk.yellow('Pré-gerando templates e assuntos de e-mail...'));
    try {
        let data = fs.readFileSync(template_path, 'utf8');
        const customSubject = subject;
        const generatedTemplates = {};
        const generatedSubjects = {};
        const limit = pLimit(parallelGeneration);

        const templatePromises = [];
        const subjectPromises = [];

        for (let sender of senders) {
            console.log(chalk.blue(`Gerando templates e assuntos para o remetente: ${sender.email}`));
            let senderTemplates = [];
            let senderSubjects = [];

            for (let i = 0; i < templatesPerBatch; i++) {
                templatePromises.push(limit(async () => {
                    let template = await generateEmailTemplate(data);
                    let templateFilePath = path.join(`./templates/${sender.email}_template_${i}.txt`);
                    fs.writeFileSync(templateFilePath, template);
                    senderTemplates.push(templateFilePath);
                    console.log(chalk.blue(`Template ${i + 1} salvo em ${templateFilePath}`));
                }));
            }

            for (let i = 0; i < subjectsPerBatch; i++) {
                subjectPromises.push(limit(async () => {
                    let generatedSubject = await generateEmailSubject(customSubject);
                    let subjectFilePath = path.join(`./subjects/${sender.email}_subject_${i}.txt`);
                    fs.writeFileSync(subjectFilePath, generatedSubject);
                    senderSubjects.push(subjectFilePath);
                    console.log(chalk.blue(`Assunto ${i + 1} salvo em ${subjectFilePath}`));
                }));
            }

            generatedTemplates[sender.email] = senderTemplates;
            generatedSubjects[sender.email] = senderSubjects;
        }

        await Promise.all([...templatePromises, ...subjectPromises]);

        console.log(chalk.green('Templates e assuntos de e-mail pré-gerados e salvos com sucesso!'));
        return { generatedTemplates, generatedSubjects };
    } catch (error) {
        console.log(chalk.red('Erro ao pré-gerar templates e assuntos de e-mail'));
        throw new Error(`Erro ao pré-gerar templates e assuntos de e-mail: ${error}`);
    }
}

async function sendEmail(transporter, sender, recipient, templates, subjects, emailCount, retryCount = 0) {
    try {
        if (!recipient.email) throw new Error('e-mail do destinatário não informado');
        
        let templateIndex = Math.floor(emailCount / 100) % templatesPerBatch;
        let subjectIndex = Math.floor(emailCount / 100) % subjectsPerBatch;
        let batchIndex = Math.floor(emailCount / 500);

        let templateFilePath = templates[sender.email][batchIndex * templatesPerBatch + templateIndex];
        let subjectFilePath = subjects[sender.email][batchIndex * subjectsPerBatch + subjectIndex];

        let html = fs.readFileSync(templateFilePath, 'utf8');
        let customSubject = subject;

        let name = recipient.name.trim();
        name = name.split(' ')[0];
        html = html.toString().replace(/{name}/g, name);
        html = html.toString().replace(/{domain}/g, config.domain);
        customSubject = customSubject.replace(/{name}/g, name);

        const text = htmlToText(html, { wordwrap: 130 });

        const mailOptions = {
            from: `Meus Rastreios <${sender.email}>`,
            to: recipient.email,
            date: new Date().toUTCString(),
            messageId: `${new Date().getMilliseconds()}@${config.domain}`,
            subject: customSubject,
            text,
            html
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(chalk.green(`E-mail enviado por ${sender.email} para ${recipient.email}: ${info.response}.`));
    } catch (error) {
        if (error.message.includes('hostinger_out_ratelimit')) {
            console.log(chalk.red(`Remetente ${sender.email} atingiu o limite: ${error.message}. Removendo remetente.`));
            senders = senders.filter(s => s.email !== sender.email);
            if (senders.length === 0) {
                throw new Error('Todos os remetentes falharam. Parando o script.');
            }
            return;
        } else if (retryCount < maxRetries) {
            console.log(chalk.red(`Erro ao enviar e-mail para ${recipient.email}: ${error.message}. Tentando novamente em ${retryDelay / 1000} segundos... (Tentativa ${retryCount + 1} de ${maxRetries})`));
            await sleep(retryDelay);
            await sendEmail(transporter, sender, recipient, templates, subjects, emailCount, retryCount + 1);
        } else {
            throw new Error(`Erro ao enviar e-mail para ${recipient.email}: ${error.message}.`);
        }
    }
}

async function sendEmails(sender, recipientList, templates, subjects) {
    const transporter = createTransporter(sender);
    const limit = pLimit(parallelEmails);
    let emailsSent = 0;

    const batchPromises = recipientList.slice(0, maxEmailsPerSender).map((recipient, index) =>
        limit(async () => {
            console.log(chalk.yellow(`Enviando e-mail ${emailsSent + 1} para o remetente: ${sender.email}`));
            await sendEmail(transporter, sender, recipient, templates, subjects, emailsSent);
            emailsSent++;
            console.log(chalk.blue(`Remetente ${sender.email} enviou ${emailsSent} e-mails.`));
            console.log(chalk.blue('Pausa de 5 segundos para o próximo envio...'));
            await sleep(delayBetweenEmails);
        })
    );

    await Promise.all(batchPromises);
}

async function readRecipientsFromCSV(filePath) {
    const recipients = [];
    console.log(chalk.yellow('Lendo destinatários do arquivo CSV...'));
    return new Promise((resolve, reject) => {
        const readInterface = readline.createInterface({
            input: fs.createReadStream(filePath),
            console: false
        });

        readInterface.on('line', (line) => {
            if (!line) reject(new Error('Arquivo de destinatários vazio'));
            const [email, name] = line.split(',');
            if (EmailValidator.validate(email)) {
                recipients.push({ email, name });
            } else {
                console.log(chalk.red(`E-mail inválido: ${email}`));
            }
        });

        readInterface.on('close', () => {
            console.log(chalk.blue('Leitura do arquivo concluída.'));
            resolve(recipients);
        });

        readInterface.on('error', (error) => {
            console.log(chalk.red('Erro ao ler o arquivo de destinatários'));
            reject(new Error(`Erro ao ler o arquivo ${filePath}, verifique se o caminho está correto: ${error.message}`));
        });
    });
}

async function distributeEmails(senders, recipients, templates, subjects) {
    console.log(chalk.yellow('Distribuindo e-mails entre os remetentes...'));
    const senderPromises = senders.map((sender, index) => {
        const senderRecipients = recipients.filter((_, i) => i % senders.length === index);
        return sendEmails(sender, senderRecipients, templates, subjects);
    });
    await Promise.all(senderPromises);
}

(async () => {
    try {
        console.log(chalk.yellow('Iniciando processamento...'));
        const recipients = await readRecipientsFromCSV(recipients_path);
        console.log(chalk.green('Arquivo de destinatários processado com sucesso'));
        console.log(chalk.blue('Iniciando pré-geração de templates e assuntos de e-mail...'));

        const { generatedTemplates, generatedSubjects } = await preGenerateTemplatesAndSubjects();
        console.log(chalk.green('Templates e assuntos de e-mail pré-gerados com sucesso!'));
        
        console.log(chalk.blue('Iniciando disparo de e-mails...'));
        await distributeEmails(senders, recipients, generatedTemplates, generatedSubjects);
    } catch (error) {
        console.error(chalk.red(`Erro: ${error.message}`));
    } finally {
        console.log(chalk.yellow('Processo concluído.'));
        process.exit();
    }
})();
